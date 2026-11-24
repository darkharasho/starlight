import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** How far the fade reaches into the list, in px. */
const FADE = 28;

/**
 * Fade mask for a scroller: each edge fades out only while there is more
 * content past it, so rows dissolve into the edge instead of being sliced
 * in half, and the first and last rows stay crisp at rest.
 */
export function fadeMask(top: boolean, bottom: boolean): CSSProperties | undefined {
  if (!top && !bottom) return undefined;
  const mask = fadeGradient(top, bottom);
  return { WebkitMaskImage: mask, maskImage: mask };
}

function fadeGradient(top: boolean, bottom: boolean): string {
  return `linear-gradient(180deg, ${top ? 'transparent 0' : '#000 0'}, #000 ${top ? FADE : 0}px, #000 calc(100% - ${bottom ? FADE : 0}px), ${bottom ? 'transparent 100%' : '#000 100%'})`;
}

/**
 * Rounds the top corners of the visible area to match the cards inside, so a
 * card scrolled part way out (and its pinned header) keeps its rounded top
 * instead of being cut square. `gutter` is the strip on the right outside the
 * cards (padding + scrollbar), which is left unclipped.
 */
function roundedTopMask(radius: number, gutter: number, bottom: boolean): CSSProperties {
  const r = radius;
  const solid = 'linear-gradient(#000, #000)';
  const layers: [string, string, string][] = [
    // [image, position, size]
    [fadeGradient(false, bottom), '0 0', '100% 100%'],
    [solid, `0 ${r}px`, `100% calc(100% - ${r}px)`],
    [solid, `${r}px 0`, `calc(100% - ${gutter + 2 * r}px) ${r}px`],
    [solid, `right 0 top 0`, `${gutter}px ${r}px`],
    [`radial-gradient(circle at 100% 100%, #000 ${r - 0.5}px, transparent ${r}px)`, '0 0', `${r}px ${r}px`],
    [`radial-gradient(circle at 0 100%, #000 ${r - 0.5}px, transparent ${r}px)`, `right ${gutter}px top 0`, `${r}px ${r}px`],
  ];
  const image = layers.map((l) => l[0]).join(', ');
  const position = layers.map((l) => l[1]).join(', ');
  const size = layers.map((l) => l[2]).join(', ');
  // The fade (top layer) intersects the union of the shape layers beneath it.
  const composite = layers.map((_, i) => (i === 0 ? 'intersect' : 'add')).join(', ');
  const webkitComposite = layers.map((_, i) => (i === 0 ? 'source-in' : 'source-over')).join(', ');
  return {
    WebkitMaskImage: image, maskImage: image,
    WebkitMaskPosition: position, maskPosition: position,
    WebkitMaskSize: size, maskSize: size,
    WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
    WebkitMaskComposite: webkitComposite, maskComposite: composite,
  };
}

/** A vertically scrolling container whose edges fade while there is more to scroll. */
export function FadeScroll({ as: Tag = 'div', fadeTop = true, roundTop, className = '', children }: {
  as?: 'div' | 'aside';
  /** Off when the content pins its own headers to the top, which would otherwise fade. */
  fadeTop?: boolean;
  /** Corner radius of the cards inside: once scrolled, the top edge is rounded to match instead of faded. */
  roundTop?: number;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false, gutter: 0 });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const cs = getComputedStyle(el);
    const gutter = Math.round(el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) + parseFloat(cs.paddingRight));
    setEdges((e) => (e.top === top && e.bottom === bottom && e.gutter === gutter ? e : { top, bottom, gutter }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // Content grows and shrinks (sections load, rows expand, the window resizes).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      measure();
    });
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [measure]);

  return (
    <Tag ref={ref as never} onScroll={measure} style={roundTop && edges.top ? roundedTopMask(roundTop, edges.gutter, edges.bottom) : fadeMask(fadeTop && edges.top, edges.bottom)}
         className={`overflow-y-auto overscroll-contain ${className}`}>
      {children}
    </Tag>
  );
}
