import { type LucideIcon } from "@lucide/vue";
import { type Ref } from "vue";
import { type Ai } from "../ai";
export declare function useAiInstance(props: {
    ai?: Ai;
}): Ai;
export declare function chipIcon(icon: string | undefined, uri: string): LucideIcon;
export declare function useMediaQuery(query: string): Ref<boolean>;
/**
 * the visual viewport (the part of the page above the on-screen keyboard) while `active`: a fixed sheet sized to it
 * keeps its bottom, the composer, above the keyboard on iOS and on Android browsers that only resize the visual viewport.
 */
export declare function useVisualViewport(active: Ref<boolean>): {
    top: number;
    height: number;
    keyboard: boolean;
};
/** iOS needs the body fixed in place, restored on release */
export declare function useScrollLock(active: Ref<boolean>): void;
/** seconds since `since`, ticking once a second while `running` */
export declare function useElapsed(running: () => boolean, since: () => number): () => number;
