import type { KernelFile } from "../types";
/** A private byte store shared by the kernel explorer and JavaScript's fs/CommonJS APIs. */
export declare class JavaScriptFiles {
    private readonly files;
    private readonly cache;
    private readonly encoder;
    private readonly decoder;
    private path;
    listFiles(): KernelFile[];
    readFile(name: string): Uint8Array;
    readText(name: string): string;
    writeFile(name: string, data: Uint8Array): void;
    removeFile(name: string): void;
    /** Text projection for assignment test contexts, never used to restore interpreter storage. */
    textFiles(): Record<string, string>;
    installCommonJS(target: object): void;
}
