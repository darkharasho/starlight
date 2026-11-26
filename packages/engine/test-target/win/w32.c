/* 32-bit Windows test program for the live 32-bit check under Proton (scripts/live-32.mjs).
 * gold = 1000 behind a 4-byte pointer chain p1 -> p2 -> gold (offsets 0), and every 200 ms a
 * noinline addGold() does gold += 1 (a script hooks its entry). Prints "addr gold=0x...",
 * "addr p1=0x..." and "addr addGold=0x..." once at start. */
#include <windows.h>
#include <stdio.h>
#include <stdint.h>

volatile int32_t gold = 1000;
volatile int32_t *volatile p2 = &gold;
volatile int32_t *volatile *volatile p1 = &p2;

__attribute__((noinline)) void addGold(void) {
    gold += 1;
}

int main(void) {
    printf("addr gold=%p\n", (void *)&gold);
    printf("addr p1=%p\n", (void *)&p1);
    printf("addr addGold=%p\n", (void *)&addGold);
    fflush(stdout);
    for (;;) {
        Sleep(200);
        addGold();
    }
    return 0;
}
