// src/code-assets.ts
function missing() {
	throw new Error("@skevo18/vue-ai-component/code-assets needs codeAssets() from @skevo18/vue-ai-component/vite in the Vite plugins.");
}
/** the folder with javascript-worker.js and python-worker.js, for createCodeTool({ assetsUrl }) */
var assetsUrl = missing();
/** the Pyodide folder, for createCodeTool({ pyodideUrl }) */
var pyodideUrl = missing();
export { assetsUrl, pyodideUrl };
