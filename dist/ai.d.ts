import { type App, type InjectionKey } from "vue";
import type { Ai, AiOptions } from "./harness/types";
export type * from "./harness/types";
export declare const AI_KEY: InjectionKey<Ai>;
export declare function useAi(): Ai;
export declare function createAi(options: AiOptions): Ai & {
    install(app: App): void;
};
