import { useEffect, useRef } from 'react';

// 浮层栈：阅读器上面再开灯箱时，Esc / 方向键只交给最上层处理
const stack: symbol[] = [];

export function useOverlay(active = true) {
  const key = useRef(Symbol('overlay'));
  useEffect(() => {
    if (!active) return;
    const k = key.current;
    stack.push(k);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      const i = stack.indexOf(k);
      if (i !== -1) stack.splice(i, 1);
      if (stack.length === 0) document.body.style.overflow = prevOverflow === 'hidden' ? '' : prevOverflow;
    };
  }, [active]);
  return () => stack[stack.length - 1] === key.current;
}
