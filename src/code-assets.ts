// @skevo18/vue-ai-component/code-assets: the URLs of the self-hosted run_code workers and Pyodide. codeAssets() from
// @skevo18/vue-ai-component/vite replaces this module with the real, content-hashed folder URLs.
function missing(): never {
  throw new Error("@skevo18/vue-ai-component/code-assets needs codeAssets() from @skevo18/vue-ai-component/vite in the Vite plugins.");
}

/** the folder with javascript-worker.js and python-worker.js, for createCodeTool({ assetsUrl }) */
export const assetsUrl: string = missing();
/** the Pyodide folder, for createCodeTool({ pyodideUrl }) */
export const pyodideUrl: string = missing();
