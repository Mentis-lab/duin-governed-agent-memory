import { useEffect, useRef, useState } from "react";

// A force-axis slider whose thumb answers to the pointer, not to the graph.
//
// It used to be a controlled <input type="range"> bound straight to BrainMap's draft state.
// Every pixel of travel re-rendered the whole map component and re-posted the full graph
// to the layout worker, so the thumb could only move as fast as a 15k-node render cycle —
// visibly behind the pointer, stuttering — and a settings echo landing mid-drag snapped it
// back to the last committed value.
//
// So the in-hand value lives here. The parent hears it once per animation frame (`onLive`,
// the live physics preview) and once on release (`onCommit`, persistence). While the thumb
// is in hand the parent's `value` is ignored; it is adopted again on release, so Reset and a
// persisted echo still land where they should.

type Props = {
  label: string;
  /** The parent's value — adopted whenever the thumb is not in hand. */
  value: number;
  /** At most once per animation frame while the value moves. */
  onLive: (v: number) => void;
  /** On release: pointer-up, pointer-cancel, key-up, or losing focus mid-drag. */
  onCommit: (v: number) => void;
};

export function LayoutSlider({ label, value, onLive, onCommit }: Props) {
  const [local, setLocal] = useState(value);
  const localRef = useRef(value);
  const inHand = useRef(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (inHand.current) return;
    localRef.current = value;
    setLocal(value);
  }, [value]);
  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);

  const move = (v: number): void => {
    localRef.current = v;
    setLocal(v);
    if (raf.current != null) return; // one delivery per frame, carrying the latest value
    raf.current = requestAnimationFrame(() => { raf.current = null; onLive(localRef.current); });
  };
  const release = (): void => {
    inHand.current = false;
    if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; }
    onCommit(localRef.current);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
        <span className="tabular-nums text-[11px] text-[var(--text-muted)]">{local}</span>
      </div>
      <input type="range" min={0} max={100} step={1} value={local}
        aria-label={label}
        onPointerDown={() => { inHand.current = true; }}
        onChange={(e) => move(Number(e.target.value))}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyUp={release}
        onBlur={() => { if (inHand.current) release(); }}
        className="h-1 w-full cursor-pointer appearance-none rounded-full outline-none"
        style={{ background: `linear-gradient(to right, var(--accent) ${local}%, var(--panel-border) ${local}%)` }}
      />
    </div>
  );
}
