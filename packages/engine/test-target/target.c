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
    if (mapped) printf("addr mapped=%p\n", mapped);
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
