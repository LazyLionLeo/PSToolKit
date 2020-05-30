import textToDom, {ParseError} from './transpiler.js';
const vscode = acquireVsCodeApi();


let errorE = document.createElement('div');
errorE.className = 'error';
document.body.appendChild(errorE);

let lastContext;
let lastPreviewE;
let lastRunner;

let fileCache = {};

window.addEventListener('message', function({data}) {
    if (data.command === 'setInput') {
        update(data.text, data.path);
    }
    else if (data.command === 'scrollTo') {
        if (lastRunner) lastRunner.scrollTo(data.line, data.column)
    }
    else {
        throw new Error("Invalid command: "+data.command);
    }
});

async function update(wiretext, path) {