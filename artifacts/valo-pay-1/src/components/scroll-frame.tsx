import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A frame that scrolls within itself: a wide table on a narrow screen, or a
 * long list held to a height. It becomes a keyboard stop, named for a screen
 * reader, only while it actually scrolls, so a table that fits adds nothing to
 * the tab order and one that does not can be scrolled with the arrow keys
 * (WCAG 2.1.1). Newer browsers do this on their own; this keeps it true in
 * the rest, and lets an audit see it.
 */
export function ScrollFrame({ label, className = 'overflow-x-auto', children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const measure = () => {
    const element = ref.current;
    if (element) setScrolls(element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
  };
  // Measured after every render, since the content (a table that has just loaded) decides; observed
  // once per frame for the resizes that happen without a render.
  useEffect(measure);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={`${className} relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`} tabIndex={scrolls ? 0 : undefined} role={scrolls ? 'region' : undefined} aria-label={scrolls ? label : undefined}>
      {children}
    </div>
  );
}
