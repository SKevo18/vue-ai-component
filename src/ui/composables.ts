import { File, FileText, Folder, Globe, Hash, Image, Link2, Mail, NotebookText, Sparkles, User, type LucideIcon } from "@lucide/vue";
import { onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from "vue";
import { useAi, type Ai } from "../ai";

export function useAiInstance(props: { ai?: Ai }): Ai {
  return props.ai ?? useAi();
}

const ICONS: Record<string, LucideIcon> = {
  file: File,
  "file-text": FileText,
  image: Image,
  folder: Folder,
  mail: Mail,
  sparkles: Sparkles,
  note: NotebookText,
  globe: Globe,
  user: User,
  hash: Hash,
  link: Link2,
};

export function chipIcon(icon: string | undefined, uri: string): LucideIcon {
  if (icon && ICONS[icon]) return ICONS[icon];
  if (uri.startsWith("skill://")) return Sparkles;
  if (uri.startsWith("attachment://")) return File;
  return Link2;
}

export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(typeof window !== "undefined" && window.matchMedia(query).matches);
  let list: MediaQueryList | null = null;
  const update = () => (matches.value = !!list?.matches);
  onMounted(() => {
    list = window.matchMedia(query);
    update();
    list.addEventListener("change", update);
  });
  onBeforeUnmount(() => list?.removeEventListener("change", update));
  return matches;
}

/**
 * the visual viewport (the part of the page above the on-screen keyboard) while `active`: a fixed sheet sized to it
 * keeps its bottom, the composer, above the keyboard on iOS and on Android browsers that only resize the visual viewport.
 */
export function useVisualViewport(active: Ref<boolean>) {
  const box = reactive({ top: 0, height: 0, keyboard: false });
  const update = () => {
    const vv = window.visualViewport;
    box.top = vv ? vv.offsetTop : 0;
    box.height = vv ? vv.height : window.innerHeight;
    box.keyboard = window.innerHeight - box.height > 120;
  };
  const listen = (on: boolean) => {
    const vv = window.visualViewport;
    const method = on ? "addEventListener" : "removeEventListener";
    vv?.[method]("resize", update);
    vv?.[method]("scroll", update);
    window[method]("resize", update);
    if (on) update();
  };
  onMounted(() => watch(active, (on, was) => on !== was && listen(on), { immediate: true }));
  onBeforeUnmount(() => listen(false));
  return box;
}

/** iOS needs the body fixed in place, restored on release */
export function useScrollLock(active: Ref<boolean>) {
  let saved: { y: number; html: string; body: string } | null = null;
  const lock = () => {
    if (saved) return;
    const body = document.body;
    saved = { y: window.scrollY, html: document.documentElement.style.cssText, body: body.style.cssText };
    document.documentElement.style.overflow = "hidden";
    Object.assign(body.style, { position: "fixed", top: `-${saved.y}px`, left: "0", right: "0", overflow: "hidden" });
  };
  const release = () => {
    if (!saved) return;
    document.documentElement.style.cssText = saved.html;
    document.body.style.cssText = saved.body;
    window.scrollTo(0, saved.y);
    saved = null;
  };
  onMounted(() => watch(active, (on) => (on ? lock() : release()), { immediate: true }));
  onBeforeUnmount(release);
}

/** seconds since `since`, ticking once a second while `running` */
export function useElapsed(running: () => boolean, since: () => number) {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() =>
    watch(
      running,
      (on) => {
        clearInterval(timer);
        now.value = Date.now();
        if (on) timer = setInterval(() => (now.value = Date.now()), 1000);
      },
      { immediate: true },
    ),
  );
  onBeforeUnmount(() => clearInterval(timer));
  return () => Math.max(0, Math.floor((now.value - since()) / 1000));
}
