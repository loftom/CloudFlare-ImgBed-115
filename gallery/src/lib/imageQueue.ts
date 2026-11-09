import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 并发受限的图片加载队列（借鉴 115Deck thumbQueue 的思路，简化版）。
 * - 原图来自 ImgBed（TG 存储，单张可能数 MB），不限流会一次性打满连接、视口内的图反而最慢。
 * - high：视口内；low：视口附近的预热。high 永远先于 low 出队。
 * - 卸载/离开时撤下 <img src>，浏览器才会真正中断请求并归还槽位。
 * - 单个请求停滞超过 STALL_TIMEOUT_MS 视为失败，释放槽位，避免整站卡死。
 *   计时从拿到并发槽、真正发出请求时开始；还在排队时不计时，超时后也不会把这次预算作废。
 */
export type Priority = 'high' | 'low';

let maxConcurrent = 4;
const STALL_TIMEOUT_MS = 30000;
let active = 0;
const loaded = new Set<string>();
const queues: Record<Priority, Task[]> = { high: [], low: [] };

interface Task {
  url: string;
  priority: Priority;
  started: boolean;
  done: boolean;
  start: () => void;
  /** 只在任务拿到并发槽、请求真正发出后才存在。排队期间没有计时器。 */
  stallTimer?: number;
}

export function setMaxConcurrent(n: number) {
  maxConcurrent = Math.max(1, Math.min(12, Math.floor(n)));
  pump();
}

export function isLoaded(url?: string) {
  return !!url && loaded.has(url);
}

function remove(task: Task) {
  for (const q of Object.values(queues)) {
    const i = q.indexOf(task);
    if (i !== -1) {
      q.splice(i, 1);
      return true;
    }
  }
  return false;
}

function pump() {
  while (active < maxConcurrent) {
    const task = queues.high.shift() || queues.low.shift();
    if (!task) return;
    if (task.done) continue;
    task.started = true;
    active++;
    task.start();
  }
}

function clearStall(task: Task) {
  if (task.stallTimer !== undefined) {
    window.clearTimeout(task.stallTimer);
    task.stallTimer = undefined;
  }
}

/**
 * 停滞计时从「已经占住并发槽」开始，而不是从入队开始。
 * 排队时就开始倒计时的话，等轮到它时预算已经耗尽，回调看到 !started 会直接返回且不会再武装，
 * 之后挂住的请求就一直占着槽位。
 */
function armInFlightStall(task: Task, onStall: () => void) {
  clearStall(task);
  task.stallTimer = window.setTimeout(() => {
    task.stallTimer = undefined;
    if (!task.started || task.done) return;
    onStall();
  }, STALL_TIMEOUT_MS);
}

function finish(task: Task | null, ok: boolean) {
  if (!task || task.done) return;
  clearStall(task);
  task.done = true;
  if (ok) loaded.add(task.url);
  if (task.started) {
    active = Math.max(0, active - 1);
    pump();
  } else {
    remove(task);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { __imageQueue: unknown }).__imageQueue = {
    active: () => active,
    pending: () => queues.high.length + queues.low.length,
    max: () => maxConcurrent,
  };
}

/**
 * @param url      目标图片地址
 * @param enabled  是否需要加载（通常 = 是否接近视口）
 * @param priority 视口内 high，预热 low
 */
export function useQueuedImage(url: string | undefined, enabled: boolean, priority: Priority = 'high') {
  const [src, setSrc] = useState<string | undefined>(() => (url && loaded.has(url) ? url : undefined));
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'error'>(() =>
    url && loaded.has(url) ? 'loaded' : 'idle',
  );
  const [nonce, setNonce] = useState(0);
  const taskRef = useRef<Task | null>(null);
  const priorityRef = useRef(priority);
  priorityRef.current = priority;

  // 优先级变化：只调整尚未启动的任务所在队列
  useEffect(() => {
    const t = taskRef.current;
    if (t && !t.started && !t.done && t.priority !== priority) {
      remove(t);
      t.priority = priority;
      queues[priority].push(t);
      pump();
    }
  }, [priority]);

  useEffect(() => {
    if (!url) {
      setSrc(undefined);
      setState('idle');
      return;
    }
    if (loaded.has(url)) {
      setSrc(url);
      setState('loaded');
      return;
    }
    if (!enabled) return;

    const task: Task = {
      url,
      priority: priorityRef.current,
      started: false,
      done: false,
      start: () => {},
    };
    task.start = () => {
      setSrc(url);
      setState('loading');
      // pump() 会先把 started 设为 true 再调用 start，此时才开始 30s 停滞计时。
      armInFlightStall(task, () => {
        finish(task, false);
        setSrc(undefined);
        setState('error');
      });
    };
    taskRef.current = task;
    queues[task.priority].push(task);
    pump();

    return () => {
      clearStall(task);
      if (taskRef.current === task) taskRef.current = null;
      if (!task.done) {
        const wasStarted = task.started;
        finish(task, false);
        if (wasStarted) {
          // 撤下 <img>，让浏览器中断在途请求
          setSrc(undefined);
          setState('idle');
        }
      }
    };
  }, [url, enabled, nonce]);

  const onLoad = useCallback(() => {
    finish(taskRef.current, true);
    if (url) loaded.add(url);
    setState('loaded');
  }, [url]);

  const onError = useCallback(() => {
    finish(taskRef.current, false);
    setSrc(undefined);
    setState('error');
  }, []);

  const retry = useCallback(() => {
    setState('idle');
    setNonce((n) => n + 1);
  }, []);

  return { src, state, onLoad, onError, retry };
}
