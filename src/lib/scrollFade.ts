// A scrolling area fades only at an edge that is hiding something, so a row cut by that edge reads as "more this way",
// never as covered, and a list that fits is never dimmed. Give the element the `scroll-fade` class (src/design/base.css)
// and this ref; it sets data-fade to "top", "bottom" or "both" from the real scroll position.
import { useLayoutEffect, useRef } from "react";

export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      const fade = top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "";
      if (el.dataset.fade !== fade) el.dataset.fade = fade;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const sizes = new ResizeObserver(update);
    sizes.observe(el);
    for (const child of el.children) sizes.observe(child);
    const kids = new MutationObserver(() => { for (const child of el.children) sizes.observe(child); update(); });
    kids.observe(el, { childList: true, subtree: true });
    return () => { el.removeEventListener("scroll", update); sizes.disconnect(); kids.disconnect(); };
  }, []);
  return ref;
}
