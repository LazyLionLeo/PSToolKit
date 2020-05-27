import textToDom, {ParseError} from './transpiler.js';
const vscode = acquireVsCodeApi();


let errorE = document.createElement