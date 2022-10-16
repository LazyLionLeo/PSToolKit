
const fs = require('fs');
const {Builder, By} = require('selenium-webdriver');
const {Options} = require('selenium-webdriver/chrome');
const path = require('path');

const BASE_DIR = path.join(__dirname, "../");
let imagecount = 0;

async function wiretextToMarkdown(wiretextFile) {
    let output = '';
    let lines = fs.readFileSync(wiretextFile).toString().split("\n");
    lines.push("# ");

    let wiretext = '';
    let text = '';
    let mode = 'text';
    let parts = [];
    for(let line of lines) {
        if (line.startsWith("# ")) {
            mode = 'text';
            if (text) text += " ";
            text += line.substr(2).trim();
        }
        else if (line.trim() !== '') {
            if (mode==='text') {
                parts.push({text, wiretext: '', show: false});
                text = '';
            }

            if (line.startsWith('define ') || line.startsWith('css') || line==='css' || line.startsWith('include ')) mode = 'define';
            else if (!line.startsWith(' ') && !line.startsWith('\t') && mode !== 'wiretext') {
                mode = 'wiretext';
                wiretext += `div id=part${parts.length-1}\n`;
                parts[parts.length-1].show = true;
            }

            if (mode==='wiretext') {
                wiretext += `\t${line}\n`;
            }
            else {
                wiretext += `${line}\n`; // define
            }
            parts[parts.length-1].wiretext += `${line}\n`;
        }
    }

    let driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(new Options().addArguments('--disable-web-security', '--disable-site-isolation-trials'))
        .build();

    wiretext = '`' + wiretext.replace(/`/g, '\\`') + '`';
    let html = `<!DOCTYPE html>
<html>
<head>
<base href="./assets/">
<style>
body > div {
    display: table;
    padding: 8px;
    background: repeating-linear-gradient(45deg, #eee, #fff 10px);
}
</style>
</head>
<body>
<script src="marked.min.js"></script>
<script type="module">
import textToDom from "./transpiler.js";
textToDom(${wiretext}, document.body, [false], ${JSON.stringify(wiretextFile)});
</script>
</body></html>
`;

    let tmpFile = "generate-readme.tmp.html";
    fs.writeFileSync(tmpFile, html);

    await driver.get(`file://${BASE_DIR}/${tmpFile}`);

    for(let index = 0; index < parts.length; index++) {
        let part = parts[index];

        let screenshot, width, filename = `docs/${++imagecount}.png`;
        if (part.show) {
            let element = await driver.findElement(By.id(`part${index}`));
            await driver.executeScript("arguments[0].scrollIntoView(true);", element);
            // await driver.sleep(500);
            screenshot = await element.takeScreenshot();
            width = (await element.getRect()).width;
        }

        output += `${part.text.replace(/</g, '&lt;')}\n\n`;
        if (part.show) {
            fs.writeFileSync(filename, screenshot, 'base64');
            output += `<img src="${filename}"${width < 350 ? ' align="right"' : ''}>\n\n`;
        }
        output += `\`\`\`wiretext\n${part.wiretext}\`\`\`\n\n`;
        output += `\n<br clear="right">\n\n`;
    }

    await driver.quit();

    fs.unlinkSync(tmpFile)
    return output;
}

async function run() {
    let readme = fs.readFileSync('docs/README.template.md').toString();

    let output = "";
    let startIndex = readme.indexOf("{{{");
    while (startIndex !== -1) {
      output += readme.substring(0, startIndex);
      readme = readme.substring(startIndex + 3);
      let endIndex = readme.indexOf("}}}");

      let filename = readme.substring(0, endIndex);
      output += await wiretextToMarkdown(`${BASE_DIR}/${filename}`);

      readme = readme.substring(endIndex + 3);
      startIndex = readme.indexOf("{{{");
    }
    output += readme;

    fs.writeFileSync('README.md', output);
}

run();