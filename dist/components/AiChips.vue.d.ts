import type { ResourceRef } from "../core/entries";
import type { Translate } from "../i18n";
type __VLS_Props = {
    items: ResourceRef[];
    t: Translate;
    removable?: boolean;
};
declare const __VLS_export: import("vue").DefineComponent<__VLS_Props, {}, {}, {}, {}, import("vue").ComponentOptionsMixin, import("vue").ComponentOptionsMixin, {
    open: (ref: ResourceRef) => any;
    remove: (ref: ResourceRef) => any;
}, string, import("vue").PublicProps, Readonly<__VLS_Props> & Readonly<{
    onOpen?: ((ref: ResourceRef) => any) | undefined;
    onRemove?: ((ref: ResourceRef) => any) | undefined;
}>, {}, {}, {}, {}, string, import("vue").ComponentProvideOptions, false, {}, any>;
declare const _default: typeof __VLS_export;
export default _default;
