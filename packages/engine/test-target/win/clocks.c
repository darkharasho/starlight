/* Windows test program for live speed checks under Proton (scripts/live-m2.mjs proton).
 * Every 250 ms it reads QueryPerformanceCounter, GetTickCount, GetTickCount64 and timeGetTime,
 * stores the time elapsed since start (in ms) in globals, bumps g_counter in a noinline
 * function (watchpoints, value scans), and prints one line:
 *   t qpc_ms=<n> tick=<n> tick64=<n> tgt=<n>
 * Once at start it prints "addr g_counter=0x...". Sleep() is not a hooked clock, so the
 * printed values advance at the game speed relative to the wall clock. */
#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdint.h>

volatile int64_t g_qpc_ms   = 0;
volatile int64_t g_tick_ms  = 0;
volatile int64_t g_tick64_ms = 0;
volatile int64_t g_tgt_ms   = 0;
/* A distinctive start value so a value scan finds few false matches. */
volatile int32_t g_counter  = 0x51A70000;

__attribute__((noinline)) void bump_counter(void) {
    g_counter += 1;
}

int main(void) {
    LARGE_INTEGER freq, qpc0, qpc;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&qpc0);
    DWORD tick0 = GetTickCount();
    ULONGLONG tick64_0 = GetTickCount64();
    DWORD tgt0 = timeGetTime();

    printf("addr g_counter=%p\n", (void*)&g_counter);
    fflush(stdout);

    for (;;) {
        Sleep(250);
        QueryPerformanceCounter(&qpc);
        g_qpc_ms = (qpc.QuadPart - qpc0.QuadPart) * 1000 / freq.QuadPart;
        g_tick_ms = (DWORD)(GetTickCount() - tick0);
        g_tick64_ms = (int64_t)(GetTickCount64() - tick64_0);
        g_tgt_ms = (DWORD)(timeGetTime() - tgt0);
        bump_counter();
        printf("t qpc_ms=%lld tick=%lld tick64=%lld tgt=%lld\n",
               (long long)g_qpc_ms, (long long)g_tick_ms, (long long)g_tick64_ms, (long long)g_tgt_ms);
        fflush(stdout);
    }
    return 0;
}
