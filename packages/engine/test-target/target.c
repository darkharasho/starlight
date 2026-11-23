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

static void* writer_loop(void* arg) {
    (void)arg;
    for (;;) {
        bump_counter();
        usleep(50 * 1000);
    }
    return NULL;
}

int main(int argc, char** argv) {
    /* --map <file>: mmap the whole file PROT_READ, MAP_PRIVATE (stands in for a Proton-mapped PE). */
    void* mapped = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--writer") == 0) {
            pthread_t th;
            if (pthread_create(&th, NULL, writer_loop, NULL) != 0) { perror("--writer"); return 1; }
        }
    }
    for (int i = 1; i + 1 < argc; i++) {
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
    printf("addr libc_clock_gettime=%p\n", dlsym(RTLD_DEFAULT, "clock_gettime"));
    if (mapped) printf("addr mapped=%p\n", mapped);
    printf("offset stats_in_player=%zu\n", offsetof(Player, stats));
    printf("offset hp_in_stats=%zu\n",     offsetof(Stats, hp));
    fflush(stdout);

    /* Idle loop. Tests will read/write our memory, then SIGTERM us. */
    while (1) {
        sleep(1);
        /* Re-touch volatile values so the compiler keeps them live. */
        (void)g_health; (void)g_speed; (void)g_souls; (void)g_byte;
        (void)g_aob_marker[0]; (void)g_after_aob;
    }
    return 0;
}
