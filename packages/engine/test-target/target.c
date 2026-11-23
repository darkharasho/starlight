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
