const TOKENIZE_REGEXP = new RegExp(String.raw`
(?:\n\s*(?:#.*)?)*\n(?<line>[ \t]*)
|
[ \t\r]+
|
(?<keyword>(?:define|run|html|include|if|for|css)\b)
|
(?<identifier>[a-zA-Z_.][a-zA-Z0-9_:.-]*)
|
(?<string>"""([\s\S]*?)"""|"(\\.|[^"\n])*")
|
(?<js>{{{[\s\S]*?}}}|{[^{}]*})
|
(?<comment>#.*)
|
(?<number>-?\s*[0-9]+)
|
(?<operator>[*/=<>!%^&|+]+)
|
(?<char>.)
`.replace(/\n/g, ""), 'g');

const JS_KEYWORDS = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield".split(" "));

const STR_REPLACEMENTS = {
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "{": "{"
};


export class ParseError extends Error {
    constructor(token, message) {
        super(message);
        this.trace = [token.range];
    }
    addCaller(token) {
        this.trace.push(token.range);
    }
    toString() {
        let message = this.message;
        for(let range of this.trace) {
            message += `\nat ${range}`;
        }
        return message;
    }
}


export class ParseCancelled extends Error {
    // Thrown when the parsing should be interrupted (because there is
    // new data).
}


class Range {
    constructor(url, line, column) {
        this.url = url;
        this.startLine = this.endLine = line;
        this.startColumn = this.endColumn = column;
    }
    setEnd(endLine, endColumn) {
        this.endLine = endLine;
        this.endColumn = endColumn;
    }
    toString() {
        let file = this.url.split('/').pop();
        return `${file}:${this.startLine+1}:${this.startColumn+1}`;
    }
}


class Captured {
    constructor(tokens, currentUrl, runMethod, start, end, vars) {
        this.tokens = tokens;
        this.currentUrl = currentUrl;
        this.runMethod = runMethod;
        this.start = start;
        this.end = end;
        this.vars = vars;
    }
    async run(parent, context, args=undefined, callerToken=undefined) {
        let runner = new Runner(this.tokens, parent, context, this.currentUrl, this.start, {...this.vars, ...args});

        try {
            await runner[this.runMethod]();
        }
        catch(e) {
            if (e instanceof ParseError && callerToken) {
                e.addCaller(callerToken);
            }
            throw e;
        }
        if (runner.tokenIndex != this.end) {
            throw new Error(`Inconsistent capture tokenIndex=${runner.tokenIndex} start=${this.start} end=${this.end}`)
        }
        return runner;
    }
    toString() {
        throw new ParseError(this.tokens[this.start], "Captured block cannot be used as a string")
    }
}


function tokenize(wiretext, url) {
    let tokens = [];
    let line = 0, column = 0;
    for (let match of wiretext.matchAll(TOKENIZE_REGEXP)) {
        // Keep track of current position in file
        let text = match[0];
        let lastNewline = text.lastIndexOf('\n');
        let range = new Range(url, line, column);
        if (lastNewline >= 0) {
            line += text.split('\n').length - 1;
            column = text.length - lastNewline - 1;
        } else {
            column += text.length;
        }
        range.setEnd(line, column);
         
        for(let k in match.groups) {
            if (match.groups[k] !== undefined) {
                tokens.push({type: k, text: match.groups[k], range});
            }
        }
    }
    let range = {startLine: line, startColumn: column, endLine: line, endColumn: column, url: url};
    tokens.push({type: 'eof', text: '', range});

    tokens = indentsToBlocks(tokens);
    //for(let token of tokens) console.log(token);

    return tokens;
}


function indentsToBlocks(inTokens) {
    let outTokens = [];
    let indents = [];
    for (let token of inTokens) {
        if (token.type === 'comment') continue;
        
        if (token.type === 'line' || token.type === 'eof') {
            outTokens.push({type: 'eol', range: token.range});
            let text = token.text;
            let pops = 0;
            for (let indent of indents) {
                if (text==='') {
                    outTokens.push({type: 'dedent', range: token.range});
                    pops += 1;
                } else if (!text.startsWith(indent)) {
                    throw new ParseError(token, `Indent mismatch ${JSON.stringify(indent)} != ${JSON.stringify(text)}`)
                } else {
                    text = text.substr(indent.length);
                }
            }
            for(let pop=0; pop<pops; pop++) indents.pop();
            if (text !== '') {
                indents.push(text);
                outTokens.push({type: 'indent', range: token.range});
            }
        }
        if (token.type !== 'line') {
            outTokens.push(token);
        }
    }
    return outTokens;
}


let includeCache = {}; // {url: Runner}

async function loadInclude(url, urlToken, context) {
    if (includeCache[url]) return includeCache[url];

    var ajax = new XMLHttpRequest();
    ajax.open("GET", url, true);
    ajax.send();
    let wiretext = await new Promise(function(resolve,reject) {
        ajax.onload = function() {
            if (ajax.status === 200) {
                resolve(ajax.responseText);
            } else {
                reject(new ParseError(urlToken, `Couldn't load ${urlToken.text}: ${ajax.statusText}`));
            }
        }
    });

    let parent = document.createElement('div');    
    let tokens = tokenize(wiretext, url);

    let runner = new Runner(tokens, parent, context, url);
    await runner.runFile();
    return includeCache[url] = runner;
}


export default async function textToDom(wiretext, parent, context, url) {

    delete includeCache[url];

    let tokens = tokenize(wiretext, url);

    let runner = new Runner(tokens, parent, context, url);
    await runner.runFile();
    return runner;
}


function setArg(define, args, name, value, tag, token) {
    if (!define) {
        args[name] = value;
    } else if (define.params.hasOwnProperty(name)) {
        args[define.params[name].jsName] = value;
    } else {
        if (define.spread == null) {
            throw new ParseError(token, `Custom element '${tag}' does not accept a '${name}' block`);
        }
        args[define.spread][name] = value;
    }
}


class Runner {
    constructor(tokens, parent, context, currentUrl, tokenIndex=0, vars={}) {
        this.tokens = tokens;
        this.parent = parent;
        this.context = context;
        this.currentUrl = currentUrl;
        this.tokenIndex = tokenIndex;
        this.vars = vars;
        this.options = [];
        this.stylesheet = [];
    }
    
    async runFile() {
        await this.yieldWork();
        
        while (this.tryCss() || await this.tryStatement()) {};
        this.require(this.matchType('eof'));

        if (this.stylesheet) {
            let styleE = document.createElement('style');
            styleE.innerHTML = this.stylesheet.join('');
            // console.log(this.stylesheet.join(''));
            this.parent.appendChild(styleE);
        }    
    }

    peek(offset=0) {
        return this.tokens[this.tokenIndex + offset];
    }

    matchText(text) {
        let token = this.tokens[this.tokenIndex];
        if (token.text === text) {
            this.options = [];
            this.tokenIndex++;
            return token;
        }
        this.options.push(`'${text}'`);
    }

    matchType(type) {
        let token = this.tokens[this.tokenIndex];
        if (token.type === type) {
            this.options = [];
            this.tokenIndex++;
            return token;
        