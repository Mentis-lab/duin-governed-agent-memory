// UI language for DUIN's chrome (nav, titles, tabs). Dictionary keyed by the canonical English label, so
// t("Brain", "zh") → "知识大脑". Vault content stays in its own language. Persisted; changing it dispatches an
// event so the shell re-renders. Keys must match the CURRENT UI labels (app-sidebar NAV + page TITLES +
// the Workflows/Outputs segment labels) — when a label is renamed, update it here too.

import { useEffect, useState } from "react";

export type Lang = "en" | "zh" | "ja";
export const LANGS: { key: Lang; label: string }[] = [
  { key: "en", label: "EN" }, { key: "zh", label: "中文" }, { key: "ja", label: "日本語" },
];

const KEY = "duin:lang";
const DICT: Record<Exclude<Lang, "en">, Record<string, string>> = {
  zh: {
    // nav + titles
    // Language-pass 2026-08-23: Brain aligned to the canon label (知识大脑 — zh.json/GLOSSARY
    // resolution; bare 大脑 stays possessive-prose only), New chat unified with zh.json's
    // 新建对话 (same button, two shells, one name), Schedules de-TW'd (排程 → 定时任务).
    Brain: "知识大脑", Insight: "洞察", "Mental Models": "心智模型", "Active Work": "进行中", Projects: "项目",
    People: "人脉", Workflows: "工作流", Outputs: "产出", Data: "数据", Chat: "对话",
    Tools: "工具", Settings: "设置", Recent: "最近", "New chat": "新建对话",
    // Workflows tabs
    Library: "能力库", Autonomy: "自主运行", Schedules: "定时任务",
    // Outputs tabs
    Intel: "情报", Documents: "文档",
    // legacy keys (kept for safety; harmless if unused)
    Dashboard: "仪表盘", "World State": "态势", Foresight: "前瞻", Decisions: "决策", Tasks: "任务",
    Conversations: "会话", Attention: "关注", Loops: "循环", Running: "自主运行", Analytics: "分析",
    Knowledge: "知识", Profile: "档案",
  },
  ja: {
    // nav + titles
    // Language-pass 2026-08-23: Intel was インテル (the chipmaker, to any JP reader) → 情報;
    // Foresight 予見 (stiff) → 先読み; Workflows-tab Library disambiguated from the documents
    // Library (スキルライブラリ); Autonomy/Running → 自律実行 (bare 自律 too terse for a tab).
    // Brain stays ブレイン deliberately — ja locale-native label; ナレッジブレイン only as gloss.
    Brain: "ブレイン", Insight: "インサイト", "Mental Models": "メンタルモデル", "Active Work": "進行中の作業", Projects: "プロジェクト",
    People: "人物", Workflows: "ワークフロー", Outputs: "アウトプット", Data: "データ", Chat: "チャット",
    Tools: "ツール", Settings: "設定", Recent: "最近", "New chat": "新規チャット",
    // Workflows tabs
    Library: "スキルライブラリ", Autonomy: "自律実行", Schedules: "スケジュール",
    // Outputs tabs
    Intel: "情報", Documents: "ドキュメント",
    // legacy keys (kept for safety; harmless if unused)
    Dashboard: "ダッシュボード", "World State": "現状", Foresight: "先読み", Decisions: "意思決定", Tasks: "タスク",
    Conversations: "会話", Attention: "注目", Loops: "ループ", Running: "自律実行", Analytics: "分析",
    Knowledge: "ナレッジ", Profile: "プロフィール",
  },
};

export function getLang(): Lang {
  if (typeof window === "undefined") return "en";
  const v = window.localStorage.getItem(KEY);
  return v === "zh" || v === "ja" ? v : "en";
}
export function setLang(lang: Lang) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, lang);
  window.dispatchEvent(new CustomEvent("duin-lang"));
}
export function t(s: string, lang: Lang): string {
  if (lang === "en") return s;
  return DICT[lang]?.[s] ?? s;
}

// Subscribe to the current UI language — for components that aren't passed `lang` as a prop (e.g. the
// Workflows/Outputs tab segments). Mirrors page.tsx's listener so labels re-render on language change.
export function useLang(): Lang {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    setLangState(getLang());
    const h = () => setLangState(getLang());
    window.addEventListener("duin-lang", h);
    return () => window.removeEventListener("duin-lang", h);
  }, []);
  return lang;
}
