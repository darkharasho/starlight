#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <pthread.h>
#include <dlfcn.h>
#include <time.h>
#include <sys/time.h>
#include <signal.h>
#include <link.h>
#include <semaphore.h>
#include <sys/syscall.h>
#include <asm/prctl.h>
#include <errno.h>

/* Stable global memory layout for tests.
 * Keep these in BSS/data so addresses are inspectable from the outside. */
volatile int32_t   g_health   = 100;
volatile float     g_speed    = 1.5f;
volatile double    g_pi       = 3.14159265358979;
volatile int64_t   g_souls    = 50000;
volatile uint8_t   g_byte     = 0x42;
char               g_name[16] = "Hero";

/* AOB pattern: a recognizable 12-byte signature, with a float right after. */
volatile uint8_t   g_aob_marker[12] = {
    0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE,
    0x12, 0x34, 0x56, 0x78
};
volatile float     g_after_aob = 9.99f;

/* Pointer chain: g_player -> stats -> hp.
 * Layout: stats struct sits at known offset from a Player struct. */
typedef struct { int32_t hp; int32_t mp; } Stats;
typedef struct { Stats* stats; int32_t level; } Player;

static Stats  s_stats  = { .hp = 250, .mp = 75 };
static Player s_player = { .stats = &s_stats, .level = 12 };
Player*       g_player = &s_player;

/* --heap-chain: g_root -> A, *(A+0x18) -> B, *(int32_t*)(B+0x10) == 777, so a pointer scan from
 * heap_value finds g_root -> [+0x18] -> [+0x10]. --decoy also points g_decoy at B (g_decoy -> [+0x10]). */
void* g_root  = NULL;
void* g_decoy = NULL;
static volatile int32_t* s_heap_value = NULL;

/* --writer: a thread bumps g_counter every 50 ms (value scans, watchpoints, patches). */
volatile int32_t   g_counter  = 0;

__attribute__((noinline)) void bump_counter(void) {
    g_counter += 1;
}

/* --spin: a thread calls spin_target in a tight loop and counts the calls (patches, hooks, ptrace). */
volatile uint64_t  g_spin_calls = 0;
volatile int       g_spin_sink  = 0;

__attribute__((noinline)) int spin_target(int x) {
    return x * 3 + 1;
}

static void* spin_loop(void* arg) {
    (void)arg;
    for (;;) {
        g_spin_sink = spin_target(g_spin_sink);
        g_spin_calls += 1;
    }
    return NULL;
}

/* Advances after every sleep(1) of the main loop, so tests can see the main thread's blocked
 * sleep restart correctly after it was interrupted by ptrace. */
volatile uint64_t  g_main_ticks = 0;

/* SIGUSR2 records the siginfo it was delivered with: {count, si_code, si_value.sival_int}, so
 * tests can check that ptrace passes a signal through unchanged. */
volatile int32_t   g_sig[3] = { 0, 0, 0 };

static void on_usr2(int sig, siginfo_t* si, void* uc) {
    (void)sig; (void)uc;
    g_sig[1] = si->si_code;
    g_sig[2] = si->si_value.sival_int;
    g_sig[0] += 1;
}

/* --clocks: a thread that every 20 ms stores the time as seen through libc's clock_gettime,
 * gettimeofday, and clock_wrapper (game speed tests). */
volatile int64_t   g_mono_ns    = 0;
volatile int64_t   g_tod_us     = 0;
volatile int64_t   g_wrapped_ns = 0;

/* A game-side function that calls clock_gettime: hooking both must scale the time once. */
__attribute__((noinline)) int clock_wrapper(clockid_t id, struct timespec* ts) {
    return clock_gettime(id, ts);
}

static void* clocks_loop(void* arg) {
    (void)arg;
    for (;;) {
        struct timespec ts;
        struct timeval tv;
        if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) g_mono_ns = (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
        if (gettimeofday(&tv, NULL) == 0) g_tod_us = (int64_t)tv.tv_sec * 1000000 + tv.tv_usec;
        if (clock_wrapper(CLOCK_MONOTONIC, &ts) == 0) g_wrapped_ns = (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
        usleep(20 * 1000);
    }
    return NULL;
}

/* --clock-signals: a thread calls clock_gettime in a tight loop while another interrupts it with
 * SIGUSR1 every 2 ms; the handler calls clock_gettime too, so some signals land while the loop
 * is inside a speed hook (and its lock). Both counters must keep rising. */
volatile uint64_t  g_clock_loops = 0;
volatile uint64_t  g_clock_sigs  = 0;

static void on_usr1(int sig) {
    (void)sig;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    g_clock_sigs += 1;
}

static void* clock_spin(void* arg) {
    (void)arg;
    for (;;) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        g_clock_loops += 1;
    }
    return NULL;
}

static void* clock_kicker(void* arg) {
    pthread_t target = *(pthread_t*)arg;
    for (;;) {
        pthread_kill(target, SIGUSR1);
        usleep(2 * 1000);
    }
    return NULL;
}

/* --clock-stall: like --clock-signals, but the SIGUSR1 handler blocks (sigsuspend) until SIGRTMIN
 * arrives 500 ms later, so the spinning thread may stay suspended while it holds a speed hook's
 * lock, as a GC's stop-the-world would leave it. Another thread keeps calling clock_gettime and
 * counts g_clock_other: it must keep making progress. */
volatile uint64_t  g_clock_other = 0;

static void on_stall(int sig) {
    (void)sig;
    sigset_t wait;
    sigfillset(&wait);
    sigdelset(&wait, SIGRTMIN);
    sigsuspend(&wait);
}

static void on_resume(int sig) { (void)sig; }

static void* clock_other(void* arg) {
    (void)arg;
    for (;;) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        g_clock_other += 1;
    }
    return NULL;
}

static void* clock_staller(void* arg) {
    pthread_t target = *(pthread_t*)arg;
    for (;;) {
        usleep(50 * 1000);
        pthread_kill(target, SIGUSR1);
        usleep(500 * 1000);
        pthread_kill(target, SIGRTMIN);
    }
    return NULL;
}

/* --win64-clocks: a thread with a fake TEB in GS (as Wine sets up its threads: gs:[0x30] is the
 * TEB's own address) calls Win64-ABI stand-ins for the Windows timing functions every 20 ms and
 * stores what they return (game speed on Proton). Counters tick at 10 MHz, tick counts in ms. */
volatile int64_t   g_w_qpc      = 0;
volatile int64_t   g_w_tick32   = 0;
volatile int64_t   g_w_tick64   = 0;
volatile int64_t   g_w_tgt      = 0;
volatile int64_t   g_w_ntqpc    = 0;
volatile int64_t   g_w_qpc_fail = 0;

static int64_t mono_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

/* QueryPerformanceCounter: BOOL f(LARGE_INTEGER*). */
__attribute__((ms_abi, noinline)) int fake_qpc(int64_t* counter) {
    *counter = mono_ns() / 100;
    return 1;
}

/* GetTickCount: DWORD f(void). */
__attribute__((ms_abi, noinline)) uint32_t fake_tick32(void) {
    return (uint32_t)(mono_ns() / 1000000);
}

/* GetTickCount64: ULONGLONG f(void). */
__attribute__((ms_abi, noinline)) uint64_t fake_tick64(void) {
    return (uint64_t)(mono_ns() / 1000000);
}

/* Wine's timeGetTime calls QueryPerformanceCounter through its import table: an indirect call
 * the compiler can't inline or see through. */
typedef int (__attribute__((ms_abi)) *qpc_fn)(int64_t*);
static qpc_fn volatile s_qpc_ptr = fake_qpc;

__attribute__((ms_abi, noinline)) uint32_t fake_time_get_time(void) {
    int64_t counter = 0;
    s_qpc_ptr(&counter);
    return (uint32_t)(counter / 10000);
}

/* NtQueryPerformanceCounter: NTSTATUS f(LARGE_INTEGER*, LARGE_INTEGER*); 0 is success. */
__attribute__((ms_abi, noinline)) int32_t fake_nt_qpc(int64_t* counter) {
    *counter = mono_ns() / 100;
    return 0;
}

/* A QueryPerformanceCounter that reports failure (FALSE) yet leaves a value behind: a hook must
 * not scale what a failed call returned. */
__attribute__((ms_abi, noinline)) int fake_qpc_fail(int64_t* counter) {
    *counter = mono_ns() / 100;
    return 0;
}

static uint8_t s_teb[0x100] __attribute__((aligned(64)));
static sem_t   s_win64_ready;

static void* win64_clocks_loop(void* arg) {
    (void)arg;
    /* glibc keeps its thread pointer in FS; GS is free on x86-64 Linux. */
    *(void**)(s_teb + 0x30) = s_teb;
    if (syscall(SYS_arch_prctl, ARCH_SET_GS, (unsigned long)s_teb) != 0) { perror("arch_prctl"); exit(1); }
    printf("addr fake_qpc=%p\n",           (void*)&fake_qpc);
    printf("addr fake_tick32=%p\n",        (void*)&fake_tick32);
    printf("addr fake_tick64=%p\n",        (void*)&fake_tick64);
    printf("addr fake_time_get_time=%p\n", (void*)&fake_time_get_time);
    printf("addr fake_nt_qpc=%p\n",        (void*)&fake_nt_qpc);
    printf("addr fake_qpc_fail=%p\n",      (void*)&fake_qpc_fail);
    printf("addr g_w_qpc=%p\n",            (void*)&g_w_qpc);
    printf("addr g_w_tick32=%p\n",         (void*)&g_w_tick32);
    printf("addr g_w_tick64=%p\n",         (void*)&g_w_tick64);
    printf("addr g_w_tgt=%p\n",            (void*)&g_w_tgt);
    printf("addr g_w_ntqpc=%p\n",          (void*)&g_w_ntqpc);
    printf("addr g_w_qpc_fail=%p\n",       (void*)&g_w_qpc_fail);
    fflush(stdout);
    sem_post(&s_win64_ready);
    for (;;) {
        int64_t c = 0;
        if (fake_qpc(&c)) g_w_qpc = c;
        g_w_tick32 = fake_tick32();
        g_w_tick64 = (int64_t)fake_tick64();
        g_w_tgt = fake_time_get_time();
        if (fake_nt_qpc(&c) == 0) g_w_ntqpc = c;
        fake_qpc_fail(&c);
        g_w_qpc_fail = c;
        usleep(20 * 1000);
    }
    return NULL;
}

/* The GOT slot this executable calls gettimeofday through (its R_X86_64_JUMP_SLOT), or NULL. */
static void* got_slot_of(const char* name) {
    ElfW(Rela)* rel = NULL;
    size_t relsz = 0;
    ElfW(Sym)* syms = NULL;
    const char* strs = NULL;
    for (ElfW(Dyn)* d = _DYNAMIC; d->d_tag != DT_NULL; d++) {
        if (d->d_tag == DT_JMPREL) rel = (ElfW(Rela)*)d->d_un.d_ptr;
        if (d->d_tag == DT_PLTRELSZ) relsz = d->d_un.d_val;
        if (d->d_tag == DT_SYMTAB) syms = (ElfW(Sym)*)d->d_un.d_ptr;
        if (d->d_tag == DT_STRTAB) strs = (const char*)d->d_un.d_ptr;
    }
    for (size_t i = 0; rel && syms && strs && i < relsz / sizeof *rel; i++) {
        if (strcmp(strs + syms[ELF64_R_SYM(rel[i].r_info)].st_name, name) == 0) return (void*)rel[i].r_offset;
    }
    return NULL;
}

/* --abs-sleep, --abs-cond, --abs-cond-rt, --abs-sem: a thread that loops "deadline = now + 20 ms
 * (read through libc's clock_gettime, so game time under speed hooks); wait until the deadline;
 * count". Each waits with an absolute deadline: clock_nanosleep(TIMER_ABSTIME) on MONOTONIC, a
 * MONOTONIC condvar (pthread_condattr_setclock), a default-clock (REALTIME) condvar, and
 * sem_timedwait (REALTIME). Under game speed s each should count 50 * s per real second.
 * --abs-cond-threads <n> starts n more --abs-cond threads, all counting into g_abs_conds. */
volatile int64_t   g_abs_sleeps   = 0;
volatile int64_t   g_abs_conds    = 0;
volatile int64_t   g_abs_conds_rt = 0;
volatile int64_t   g_abs_sems     = 0;

#define ABS_STEP_NS (20 * 1000000L)

static struct timespec deadline_in(clockid_t clock, long ns) {
    struct timespec ts;
    clock_gettime(clock, &ts);
    ts.tv_nsec += ns;
    while (ts.tv_nsec >= 1000000000L) { ts.tv_nsec -= 1000000000L; ts.tv_sec += 1; }
    return ts;
}

static void* abs_sleep_loop(void* arg) {
    (void)arg;
    for (;;) {
        struct timespec d = deadline_in(CLOCK_MONOTONIC, ABS_STEP_NS);
        while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &d, NULL) == EINTR) {}
        __atomic_fetch_add(&g_abs_sleeps, 1, __ATOMIC_RELAXED);
    }
    return NULL;
}

/* arg: the clock the condvar uses (CLOCK_MONOTONIC or CLOCK_REALTIME = the default) and where to count. */
typedef struct { clockid_t clock; volatile int64_t* counter; } AbsCond;

static void* abs_cond_loop(void* arg) {
    const AbsCond* a = arg;
    pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
    pthread_cond_t c;
    pthread_condattr_t attr;
    pthread_condattr_init(&attr);
    if (a->clock != CLOCK_REALTIME) pthread_condattr_setclock(&attr, a->clock);
    pthread_cond_init(&c, &attr);
    pthread_mutex_lock(&m);
    for (;;) {
        struct timespec d = deadline_in(a->clock, ABS_STEP_NS);
        /* Nobody signals: every return but ETIMEDOUT is spurious. */
        while (pthread_cond_timedwait(&c, &m, &d) != ETIMEDOUT) {}
        __atomic_fetch_add(a->counter, 1, __ATOMIC_RELAXED);
    }
    return NULL;
}

static void* abs_sem_loop(void* arg) {
    (void)arg;
    sem_t s;
    sem_init(&s, 0, 0);
    for (;;) {
        struct timespec d = deadline_in(CLOCK_REALTIME, ABS_STEP_NS);
        while (sem_timedwait(&s, &d) != 0 && errno != ETIMEDOUT) {}
        __atomic_fetch_add(&g_abs_sems, 1, __ATOMIC_RELAXED);
    }
    return NULL;
}

static AbsCond s_abs_mono = { CLOCK_MONOTONIC, &g_abs_conds };
static AbsCond s_abs_rt   = { CLOCK_REALTIME,  &g_abs_conds_rt };

static void* writer_loop(void* arg) {
    (void)arg;
    for (;;) {
        bump_counter();
        usleep(50 * 1000);
    }
    return NULL;
}

int main(int argc, char** argv) {
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = on_usr2;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigaction(SIGUSR2, &sa, NULL);

    /* --map <file>: mmap the whole file PROT_READ, MAP_PRIVATE (stands in for a Proton-mapped PE). */
    void* mapped = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--writer") == 0) {
            pthread_t th;
            if (pthread_create(&th, NULL, writer_loop, NULL) != 0) { perror("--writer"); return 1; }
        }
        if (strcmp(argv[i], "--clocks") == 0) {
            pthread_t th;
            if (pthread_create(&th, NULL, clocks_loop, NULL) != 0) { perror("--clocks"); return 1; }
        }
        if (strcmp(argv[i], "--clock-signals") == 0) {
            static pthread_t spinner;
            pthread_t kicker;
            struct sigaction su;
            memset(&su, 0, sizeof su);
            su.sa_handler = on_usr1;
            su.sa_flags = SA_RESTART;
            sigaction(SIGUSR1, &su, NULL);
            if (pthread_create(&spinner, NULL, clock_spin, NULL) != 0 ||
                pthread_create(&kicker, NULL, clock_kicker, &spinner) != 0) { perror("--clock-signals"); return 1; }
        }
        if (strcmp(argv[i], "--clock-stall") == 0) {
            static pthread_t stalled;
            pthread_t other, staller;
            struct sigaction ss;
            memset(&ss, 0, sizeof ss);
            ss.sa_handler = on_stall;
            sigaction(SIGUSR1, &ss, NULL);
            ss.sa_handler = on_resume;
            sigaction(SIGRTMIN, &ss, NULL);
            if (pthread_create(&stalled, NULL, clock_spin, NULL) != 0 ||
                pthread_create(&other, NULL, clock_other, NULL) != 0 ||
                pthread_create(&staller, NULL, clock_staller, &stalled) != 0) { perror("--clock-stall"); return 1; }
        }
        if (strcmp(argv[i], "--win64-clocks") == 0) {
            /* The thread prints its part of the listing; wait for it so the listing stays whole. */
            pthread_t th;
            sem_init(&s_win64_ready, 0, 0);
            if (pthread_create(&th, NULL, win64_clocks_loop, NULL) != 0) { perror("--win64-clocks"); return 1; }
            sem_wait(&s_win64_ready);
        }
        if (strcmp(argv[i], "--abs-sleep") == 0 || strcmp(argv[i], "--abs-cond") == 0 ||
            strcmp(argv[i], "--abs-cond-rt") == 0 || strcmp(argv[i], "--abs-sem") == 0) {
            pthread_t th;
            int r;
            if (strcmp(argv[i], "--abs-sleep") == 0) r = pthread_create(&th, NULL, abs_sleep_loop, NULL);
            else if (strcmp(argv[i], "--abs-cond") == 0) r = pthread_create(&th, NULL, abs_cond_loop, &s_abs_mono);
            else if (strcmp(argv[i], "--abs-cond-rt") == 0) r = pthread_create(&th, NULL, abs_cond_loop, &s_abs_rt);
            else r = pthread_create(&th, NULL, abs_sem_loop, NULL);
            if (r != 0) { perror(argv[i]); return 1; }
        }
        if (strcmp(argv[i], "--abs-cond-threads") == 0 && i + 1 < argc) {
            int n = atoi(argv[i + 1]);
            for (int k = 0; k < n; k++) {
                pthread_t th;
                if (pthread_create(&th, NULL, abs_cond_loop, &s_abs_mono) != 0) { perror("--abs-cond-threads"); return 1; }
            }
        }
        if (strcmp(argv[i], "--spin") == 0) {
            pthread_t th;
            if (pthread_create(&th, NULL, spin_loop, NULL) != 0) { perror("--spin"); return 1; }
        }
    }
    /* --late-writer <ms>: start the writer thread only <ms> after the listing below is printed,
     * so tests can watch g_counter before the thread that writes it exists. */
    long late_writer_ms = -1;
    for (int i = 1; i + 1 < argc; i++) {
        if (strcmp(argv[i], "--late-writer") == 0) {
            late_writer_ms = atol(argv[i + 1]);
        }
        if (strcmp(argv[i], "--map") == 0) {
            int fd = open(argv[i + 1], O_RDONLY);
            struct stat st;
            if (fd < 0 || fstat(fd, &st) != 0 || st.st_size == 0) { perror("--map"); return 1; }
            mapped = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
            if (mapped == MAP_FAILED) { perror("mmap"); return 1; }
            close(fd);
        }
    }

    int heap_chain = 0, decoy = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--heap-chain") == 0) heap_chain = 1;
        if (strcmp(argv[i], "--decoy") == 0) decoy = 1;
    }
    if (heap_chain) {
        char* a = malloc(0x40);
        char* b = malloc(0x40);
        if (!a || !b) { perror("--heap-chain"); return 1; }
        memset(a, 0, 0x40);
        memset(b, 0, 0x40);
        *(void**)(a + 0x18) = b;
        *(int32_t*)(b + 0x10) = 777;
        s_heap_value = (volatile int32_t*)(b + 0x10);
        g_root = a;
        if (decoy) g_decoy = b;
    }

    /* Print addresses on startup so tests can locate them.
     * Format is parsed by the spawn-target test helper. */
    printf("READY\n");
    printf("addr g_health=%p\n",      (void*)&g_health);
    printf("addr g_speed=%p\n",       (void*)&g_speed);
    printf("addr g_pi=%p\n",          (void*)&g_pi);
    printf("addr g_souls=%p\n",       (void*)&g_souls);
    printf("addr g_byte=%p\n",        (void*)&g_byte);
    printf("addr g_name=%p\n",        (void*)g_name);
    printf("addr g_aob_marker=%p\n",  (void*)g_aob_marker);
    printf("addr g_after_aob=%p\n",   (void*)&g_after_aob);
    printf("addr g_player_ptr=%p\n",  (void*)&g_player);
    printf("addr g_counter=%p\n",     (void*)&g_counter);
    printf("addr bump_counter=%p\n",  (void*)&bump_counter);
    printf("addr spin_target=%p\n",   (void*)&spin_target);
    printf("addr g_spin_calls=%p\n",  (void*)&g_spin_calls);
    printf("addr g_main_ticks=%p\n",  (void*)&g_main_ticks);
    printf("addr g_sig=%p\n",         (void*)g_sig);
    printf("addr libc_clock_gettime=%p\n", dlsym(RTLD_DEFAULT, "clock_gettime"));
    printf("addr g_mono_ns=%p\n",    (void*)&g_mono_ns);
    printf("addr g_tod_us=%p\n",     (void*)&g_tod_us);
    printf("addr g_wrapped_ns=%p\n", (void*)&g_wrapped_ns);
    printf("addr clock_wrapper=%p\n", (void*)&clock_wrapper);
    printf("addr g_clock_loops=%p\n", (void*)&g_clock_loops);
    printf("addr g_clock_sigs=%p\n",  (void*)&g_clock_sigs);
    printf("addr g_clock_other=%p\n", (void*)&g_clock_other);
    printf("addr got_gettimeofday=%p\n", got_slot_of("gettimeofday"));
    printf("addr g_abs_sleeps=%p\n",   (void*)&g_abs_sleeps);
    printf("addr g_abs_conds=%p\n",    (void*)&g_abs_conds);
    printf("addr g_abs_conds_rt=%p\n", (void*)&g_abs_conds_rt);
    printf("addr g_abs_sems=%p\n",     (void*)&g_abs_sems);
    /* dlsym gives each name's default version, the one a game links against. */
    printf("addr libc_clock_nanosleep=%p\n",        dlsym(RTLD_DEFAULT, "clock_nanosleep"));
    printf("addr libc_pthread_cond_timedwait=%p\n", dlsym(RTLD_DEFAULT, "pthread_cond_timedwait"));
    printf("addr libc_pthread_cond_clockwait=%p\n", dlsym(RTLD_DEFAULT, "pthread_cond_clockwait"));
    printf("addr libc_sem_timedwait=%p\n",          dlsym(RTLD_DEFAULT, "sem_timedwait"));
    printf("addr libc_sem_clockwait=%p\n",          dlsym(RTLD_DEFAULT, "sem_clockwait"));
    if (mapped) printf("addr mapped=%p\n", mapped);
    if (heap_chain) {
        printf("addr g_root=%p\n",       (void*)&g_root);
        printf("addr g_decoy=%p\n",      (void*)&g_decoy);
        printf("addr heap_value=%p\n",   (void*)s_heap_value);
    }
    printf("offset stats_in_player=%zu\n", offsetof(Player, stats));
    printf("offset hp_in_stats=%zu\n",     offsetof(Stats, hp));
    fflush(stdout);

    if (late_writer_ms >= 0) {
        usleep((useconds_t)late_writer_ms * 1000);
        pthread_t th;
        if (pthread_create(&th, NULL, writer_loop, NULL) != 0) { perror("--late-writer"); return 1; }
    }

    /* Idle loop. Tests will read/write our memory, then SIGTERM us. */
    while (1) {
        sleep(1);
        g_main_ticks += 1;
        /* Re-touch volatile values so the compiler keeps them live. */
        (void)g_health; (void)g_speed; (void)g_souls; (void)g_byte;
        (void)g_aob_marker[0]; (void)g_after_aob;
    }
    return 0;
}
