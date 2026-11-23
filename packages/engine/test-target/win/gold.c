/* Windows test program for the live agent checks under Proton (scripts/live-m3.mjs proton).
 * It allocates a player struct on the heap, { pad[0x10]; int32 gold = 500 }, keeps its pointer in
 * the static g_player (so a pointer scan finds gold.exe+<g_player> -> +0x10), and every 500 ms a
 * noinline earn() does gold += 1 (value scans "increased", write watches, a `ret` patch on earn).
 * Once at start it prints "addr g_player=0x..." and "addr earn=0x...". */
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

struct player {
    uint8_t pad[0x10];
    volatile int32_t gold;
};

static struct player *volatile g_player = NULL;

__attribute__((noinline)) void earn(void) {
    g_player->gold += 1;
}

int main(void) {
    g_player = (struct player *)calloc(1, sizeof(struct player));
    if (!g_player) return 1;
    g_player->gold = 500;

    printf("addr g_player=%p\n", (void *)&g_player);
    printf("addr earn=%p\n", (void *)&earn);
    fflush(stdout);

    for (;;) {
        Sleep(500);
        earn();
    }
    return 0;
}
