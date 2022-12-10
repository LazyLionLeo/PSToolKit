
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const path = require('path');

let panel;
let typingTimeout;
let editor;


const decorationType = vscode.window.createTextEditorDecorationType({
	borderWidth: '1px',
	borderStyle: 'solid',
	overviewRulerColor: 'red',
	borderColor: 'red',
});


function isWireTextOpen() {
	return vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'wiretext';
}

function activate(context) {
		
	function openPane() {
		if (panel) {
			// If we already have a panel, show it
			try {
				panel.reveal();
				return;
			} catch(e) {}
		}
		console.log('Creating new panel');

		panel = vscode.window.createWebviewPanel(
			'wiretext',
			'WireText preview',
			{
				preserveFocus: false,
				viewColumn: vscode.ViewColumn.Beside
			},
			{
				enableScripts: true
				// localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'assets'))],
			},
		);

		const assetsPath = ''+panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'assets')));

		panel.webview.html = getWebviewContent(assetsPath);

		panel.webview.onDidReceiveMessage(
			function(message) {
				if (message.command === 'error') {
					let decorations = [];
					for(let range of message.trace) {
						if (range.url.endsWith(editor.document.fileName)) {
							range = new vscode.Range(range.startLine, range.startColumn, range.endLine, range.endColumn);
							decorations.push({range, hoverMessage: {language: "text/plain", value: message.text}});
							break;
						}
					}
					editor.setDecorations(decorationType, decorations);
				} else if (message.command === 'ok') {
					editor.setDecorations(decorationType, []);
				}
			},
			undefined,
			context.subscriptions
		);
	}

	function start() {
		if (!isWireTextOpen()) {
			vscode.window.showErrorMessage('Please open a WriteText .wt file in the editor');
			return;
		}
		editor = vscode.window.activeTextEditor;
		openPane()
	
		refreshView();
	}

	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(function(){
		if (isWireTextOpen()) {
			start();
		}
	}));

	// Listen for active document changes, i.e. user typing
	vscode.workspace.onDidChangeTextDocument(event => {
		if (editor && event.document === editor.document) {
			clearTimeout(typingTimeout);
			typingTimeout = setTimeout(refreshView, 50);
		}
	});

	vscode.window.onDidChangeTextEditorSelection(event => {
		if (event.selections.length==1) {
			try {
				let pos = event.selections[0].start;
				panel.webview.postMessage({ command: 'scrollTo', line: pos.line, column: pos.character});
			}
			catch(e) {
				panel = undefined;
			}
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('wiretext.preview', start));
	if (isWireTextOpen()) start();
}


async function refreshView() {
	if (!panel || !editor) return;
	panel.webview.postMessage({
		command: 'setInput',
		text: editor.document.getText(),
		// fileName: editor.document.fileName,
		path: panel.webview.asWebviewUri(vscode.Uri.file(editor.document.fileName)).toString()
	});
}


function getWebviewContent(assetsPath) {
	return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>WireText Preview</title>
	<base href="${assetsPath}/">
    <link rel="stylesheet" href="wiretext.css">
  </head>
  <body>
  	<script src="marked.min.js"></script>
    <script src="browser.js" type="module"></script>
  </body>
</html>
`
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
};