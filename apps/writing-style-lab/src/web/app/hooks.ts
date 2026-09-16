/**
 * 编辑区核心 hook：IME 安全的自动保存草稿控制器。
 *
 * 为什么不能简单地「受控 textarea + debounce 保存」：
 * 中文输入法在组合（composing）期间，DOM 里的 value 是半成品（拼音串 / 候选词）。
 * 如果这时用 React state 回写 value，或者把半成品落盘，就会出现「光标跳到末尾」「重复插字」「草稿被拼音覆盖」。
 * 这里用三道闸门挡住：
 *   1. onCompositionStart 起，到 CompositionEvent 结束为止，任何外部（程序侧）文本替换都只进 pending，不直接写 value；
 *   2. 组合期间 onChange 里的 setText 只跟随用户输入（不会与 DOM 值打架），同时把已排队的保存取消；
 *   3. 组合期间绝不落盘；compositionEnd 之后再排一次保存。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent } from 'react';

export type DraftSaveStatus = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

export interface DraftTextController {
  text: string;
  composing: boolean;
  status: DraftSaveStatus;
  message: string | null;
  savedAt: string | null;
  dirty: boolean;
  textareaProps: {
    value: string;
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
    onBlur: () => void;
  };
  /** 程序侧替换正文（导入文件、载入旧样本、另存为草稿）。组合输入期间会挂起，等组合结束后再应用。 */
  replaceText: (next: string, options?: { deferIfComposing?: boolean; reason?: string }) => void;
  /** 立刻落盘（不看 debounce）。 */
  saveNow: () => Promise<void>;
  /** 丢弃当前内存状态，从存储重新读一次。 */
  reload: () => Promise<void>;
}

export function useDraftText(options: {
  /** 草稿标识（换 key 就换一份草稿）。 */
  loadKey: string;
  load: (key: string) => Promise<string>;
  persist: (key: string, text: string) => Promise<void>;
  delayMs?: number;
}): DraftTextController {
  const { loadKey, delayMs = 1200 } = options;
  const fnsRef = useRef({ load: options.load, persist: options.persist, loadKey });
  useEffect(() => {
    fnsRef.current.load = options.load;
    fnsRef.current.persist = options.persist;
    fnsRef.current.loadKey = loadKey;
  }, [options.load, options.persist, loadKey]);

  const [text, setText] = useState('');
  const [status, setStatus] = useState<DraftSaveStatus>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [composing, setComposing] = useState(false);

  const composingRef = useRef(false);
  const textRef = useRef('');
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingExternalRef = useRef<{ text: string; reason?: string } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const runSave = useCallback(async () => {
    const key = fnsRef.current.loadKey;
    const value = textRef.current;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setStatus('saving');
    setMessage(null);
    try {
      await fnsRef.current.persist(key, value);
      if (!mountedRef.current || seq !== seqRef.current) return;
      setStatus('saved');
      setSavedAt(new Date().toISOString());
      setDirty(textRef.current !== value);
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setStatus('error');
      setMessage(`保存失败：${err instanceof Error ? err.message : '未知错误'}。正文仍在编辑区里，请先不要关闭页面。`);
    }
  }, []);

  const schedule = useCallback(
    (next: string) => {
      textRef.current = next;
      setDirty(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        // 组合输入还没结束：不落盘，交给 compositionEnd / 下一次输入重新排队。
        if (composingRef.current) return;
        void runSave();
      }, delayMs);
    },
    [delayMs, runSave],
  );

  const loadFromStore = useCallback(async () => {
    setStatus('loading');
    setMessage(null);
    try {
      const loaded = await fnsRef.current.load(fnsRef.current.loadKey);
      if (!mountedRef.current) return;
      if (composingRef.current) {
        pendingExternalRef.current = { text: loaded, reason: '载入的草稿在组合输入期间到达，已等组合结束后替换' };
        return;
      }
      textRef.current = loaded;
      setText(loaded);
      setDirty(false);
      setStatus('idle');
      setSavedAt(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus('error');
      setMessage(`读取草稿失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  }, []);

  useEffect(() => {
    void loadFromStore();
  }, [loadKey, loadFromStore]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      setText(next);
      schedule(next);
    },
    [schedule],
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    setComposing(true);
    // 组合期间取消已排队的保存，避免把拼音串写进存储。
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false;
      setComposing(false);
      const next = event.currentTarget.value;
      setText(next);
      schedule(next);
      const pending = pendingExternalRef.current;
      if (pending) {
        pendingExternalRef.current = null;
        textRef.current = pending.text;
        setText(pending.text);
        setDirty(true);
        setMessage(pending.reason ?? null);
        schedule(pending.text);
      }
    },
    [schedule],
  );

  const handleBlur = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (composingRef.current) return;
    void runSave();
  }, [runSave]);

  const replaceText = useCallback(
    (next: string, opts?: { deferIfComposing?: boolean; reason?: string }) => {
      if (composingRef.current && opts?.deferIfComposing !== false) {
        pendingExternalRef.current = { text: next, reason: opts?.reason };
        return;
      }
      textRef.current = next;
      setText(next);
      setDirty(true);
      schedule(next);
    },
    [schedule],
  );

  const saveNow = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (composingRef.current) {
      setMessage('输入法组合输入尚未结束，暂不落盘（组合结束后会自动保存）。');
      return;
    }
    await runSave();
  }, [runSave]);

  const textareaProps = useMemo(
    () => ({
      value: text,
      onChange: handleChange,
      onCompositionStart: handleCompositionStart,
      onCompositionEnd: handleCompositionEnd,
      onBlur: handleBlur,
    }),
    [text, handleChange, handleCompositionStart, handleCompositionEnd, handleBlur],
  );

  return {
    text,
    composing,
    status,
    message,
    savedAt,
    dirty,
    textareaProps,
    replaceText,
    saveNow,
    reload: loadFromStore,
  };
}
