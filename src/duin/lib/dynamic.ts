// Vite/Electron shim for next/dynamic (ssr:false cases). DUIN's web used
// `dynamic(() => import("react-force-graph-2d"), { ssr:false })` to keep
// canvas/three libs out of SSR. Electron has no SSR, so we just lazy-load and
// wrap in Suspense internally — callers render <ForceGraph2D/> unchanged.
import { lazy, Suspense, createElement, type ComponentType } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function dynamic<P = any>(
  loader: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>,
  _opts?: { ssr?: boolean }
): ComponentType<P> {
  const Lazy = lazy(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = await loader()
    return { default: (m && m.default ? m.default : m) as ComponentType<P> }
  })
  return ((props: P) =>
    createElement(
      Suspense,
      { fallback: null },
      // `Lazy` is a LazyExoticComponent<ComponentType<P>>; createElement can't
      // validate props for an unconstrained generic P, so route through a
      // props-agnostic component type. The runtime element is identical.
      createElement(Lazy as ComponentType<Record<string, unknown>>, props as Record<string, unknown>)
    )) as ComponentType<P>
}
