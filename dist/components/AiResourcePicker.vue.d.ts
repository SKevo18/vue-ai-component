import type { Ai } from "../ai";
import type { ResourceRef } from "../core/entries";
type __VLS_Props = {
    ai: Ai;
    anchor: HTMLElement | null;
    boundary?: HTMLElement | null;
    query: string;
};
declare function key(e: KeyboardEvent): boolean;
type __VLS_ModelProps = {
    "open": boolean;
};
type __VLS_PublicProps = __VLS_Props & __VLS_ModelProps;
declare const __VLS_export: import("vue").DefineComponent<__VLS_PublicProps, {
    key: typeof key;
}, {}, {}, {}, import("vue").ComponentOptionsMixin, import("vue").ComponentOptionsMixin, {
    "update:open": (value: boolean) => any;
    pick: (ref: ResourceRef) => any;
}, string, import("vue").PublicProps, Readonly<__VLS_PublicProps> & Readonly<{
    "onUpdate:open"?: ((value: boolean) => any) | undefined;
    onPick?: ((ref: ResourceRef) => any) | undefined;
}>, {}, {}, {}, {}, string, import("vue").ComponentProvideOptions, false, {}, any>;
declare const _default: typeof __VLS_export;
export default _default;
