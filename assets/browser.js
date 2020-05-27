import textToDom, {ParseError} from './transpiler.js';
const vscode = acquireVsCodeApi();


let errorE = document.createElement('div');
errorE.className = 'error';
document.body.appendChild(errorE);

let lastContext;
let lastPreviewE;
let lastRunner;

l