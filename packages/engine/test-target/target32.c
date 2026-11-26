/* i386 test target for starlightd's 32-bit paths. Freestanding: this machine has no i386 libc, so it
 * talks to the kernel with `int 0x80` directly. Prints its addresses like `target`, ending with
 * `offset hp_in_stats=0`, then sleeps forever.
 *
 *   gold: int = 1234
 *   p1 -> p2 -> gold, 4-byte pointers, offsets 0
 */
static int sys3(int n, int a, int b, int c) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(n), "b"(a), "c"(b), "d"(c) : "memory");
    return r;
}

volatile int gold = 1234;
volatile int *volatile p2 = &gold;
volatile int *volatile *volatile p1 = &p2;

static int len(const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}

static void put(const char *s) { sys3(4, 1, (int)s, len(s)); }

static void put_addr(const char *name, unsigned v) {
    char buf[16];
    const char *hex = "0123456789abcdef";
    int i;
    put("addr ");
    put(name);
    put("=0x");
    for (i = 0; i < 8; i++) buf[i] = hex[(v >> (28 - 4 * i)) & 0xf];
    buf[8] = '\n';
    buf[9] = 0;
    put(buf);
}

void _start(void) {
    struct { int s, ns; } t = {0, 50000000};
    put_addr("gold", (unsigned)&gold);
    put_addr("p1", (unsigned)&p1);
    put_addr("p2", (unsigned)&p2);
    put("offset hp_in_stats=0\n");
    for (;;) sys3(162, (int)&t, 0, 0);
}
