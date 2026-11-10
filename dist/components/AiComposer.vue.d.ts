import type { Ai } from "../ai";
type __VLS_Props = {
    ai?: Ai;
    boundary?: HTMLElement | null;
    autofocus?: boolean;
};
declare function openPicker(): void;
declare function focusEnd(): void;
declare const __VLS_export: import("vue").DefineComponent<__VLS_Props, {
    focus: typeof focusEnd;
    openPicker: typeof openPicker;
}, {}, {}, {}, import("vue").ComponentOptionsMixin, import("vue").ComponentOptionsMixin, {
    escape: () => any;
}, string, import("vue").PublicProps, Readonly<__VLS_Props> & Readonly<{
    onEscape?: (() => any) | undefined;
}>, {}, {}, {}, {}, string, import("vue").ComponentProvideOptions, false, {}, any>;
declare const _default: typeof __VLS_export;
export default _default;
