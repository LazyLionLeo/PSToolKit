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
        }
        this.options.push(`<${type}>`);
    }

    throwExpectedError() {
        let token = this.peek();
        throw new ParseError(token, `Expected ${this.options.join(' or ')} but got <${token.type}>${token.text===undefined ? '' : ` '${token.text}'`}`);
    }

    require(value) {
        if (value !== undefined && value !== false) return value;
        this.throwExpectedError();
    }

    trySkipBlock() {
        if (!this.matchType('indent')) return false;

        // Read up until the matching dedent
        let depth = 1;
        while(depth > 0) {
            if (this.matchType('dedent')) depth--;
            else if (this.tokens[this.tokenIndex++].type === 'indent') depth++;
        }
        return true;
    }

    trySkipStatementOrBlock() {
        if (this.matchType('eol')) {
            return this.trySkipBlock();
        } else {
            while(!this.matchType('eol')) { this.tokenIndex++; }
            this.trySkipBlock();
            return true;
        }
    }

    tryCaptureStatementOrBlock() {
        // Returns Captured if a statement or a block of statements was found.
        let start = this.tokenIndex;
        if (this.trySkipStatementOrBlock()) {
            return new Captured(this.tokens, this.currentUrl, 'tryRunStatementOrBlock', start, this.tokenIndex, this.vars);
        }
    }

    async tryRunStatementOrBlock() {
        if (this.matchType('eol')) {
            return await this.tryBlock();
        }
        else {
            return await this.tryStatement();
        }
    }

    evalJs(js, token, thisObject) {
        if (js.startsWith('{{{')) js = js.substr(3, js.length-6);
        else js = `return (${js.substr(1, js.length-2)})`;
        try {
            return Function(...Object.keys(this.vars), js).apply(thisObject, Object.values(this.vars));
        }
        catch(e) {
            let varDump = [];
            for(let key in this.vars) {
                let val = this.vars[key];
                if (val instanceof Captured) val = "<block>";
                else val = JSON.stringify(val);
                varDump.push(`${key}=${val}`)
            }
            throw new ParseError(token, `${e.toString()}\nfor JavaScript: ${js}\nwith this.vars: ${varDump.join(' ')}\n`);
        }
    }

    evalString(str, token) {
        if (str.startsWith('"""')) {
            // Remove the quotes
            str = str.substr(3, str.length-6)
            // Remove first line if empty
            str = str.replace(/^\s*\n/, ''); 
            // Remove whitespace prefix that is common to all lines.
            let lines = str.split('\n');
            let prefix;
            for(let line of lines) {
                if (line.trim()) {
                    let idx, commonLen = (prefix===undefined || line.length > prefix.length) ? line.length : prefix.length;
                    for(idx = 0; idx < commonLen; idx++) {
                        let char = line[idx];
                        if ((char != ' ' && char != '\t') || (prefix!==undefined && char != prefix[idx])) break;
                    }
                    if (prefix===undefined || idx < prefix.length) prefix = line.substr(0, idx);
                }
            }
            if (prefix) {
                for(let idx=0; idx<lines.length; idx++) {
                    lines[idx] = lines[idx].substr(prefix.length);
                }
            }
            str = lines.join('\n');
        } else {
            str = str.substr(1, str.length-2);
        }
        let start;
        let depth = 0;
        for (let pos=0; pos<str.length; pos++) {
            let char = str[pos];
            if (char==='\\' && pos<str.length-1) {
                let next = str[pos+1];
                let out = STR_REPLACEMENTS[next];
                if (out) {
                    str = str.substr(0, pos) + out + str.substr(pos+2);
                }
            }
            else if (char==='{') {
                if (!depth++) start = pos;
            }
            else if (char==='}') {
                if (!--depth) {
                    let js = str.substring(start, pos+1);
                    let out = ""+this.evalJs(js, token);
                    str = str.substr(0, start) + out + str.substr(pos+1);
                    pos = start + out.length - 1;
                }
            }
        }
        return str;
    }

    parseValue() {
        let token;
        if (token = this.matchType('js')) {
            return this.evalJs(token.text, token);
        }
        else if (token = this.matchType('string')) {
            return this.evalString(token.text, token);
        }
        else if (token = this.matchType('identifier')) {
            return token.text;
        }
        else if (token = this.matchType('number')) {
            return 0|token.text;
        }
        else {
            this.throwExpectedError();
        }
    }

    async tryStatement() {
        return this.matchType('eol') || this.tryDefine() || this.tryRun() || this.tryHtml() || (await this.tryInclude()) || (await this.tryLiteral()) || (await this.tryIf()) || (await this.tryFor()) || (await this.tryNode());
    }

    tryDefine() {
        if (!this.matchText('define')) return false;

        let nameToken = this.require(this.matchType('identifier'));
        let name = nameToken.text;
        if (name[0].toUpperCase() !== name[0]) {
            throw new ParseError(nameToken, "Custom element names cannot start with a lower case letter");
        }

        let params = {};
        let spread;

        if (this.matchText('(')) { // the parameters
            let paramToken = this.matchType('identifier');
            if (paramToken) {
                const addParam = jsName => {
                    if (jsName.substr(0,3)==='...') {
                        jsName = jsName.substr(3);
                        if (spread!=null) throw new ParseError(this.peek(-1), "Only a single spread parameter can be used");
                        spread = true; // will be set to param name below
                    }                    
                    if (!jsName.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/)) throw new ParseError(this.peek(-1), `Parameter name '${jsName}' contains invalid characters`);
                    if (JS_KEYWORDS.has(jsName)) throw new ParseError(this.peek(-1), `JavaScript keyword '${jsName}' cannot be used as a parameter name`);

                    let param = jsName;
                    if (param.endsWith('_')) {
                        param = param.substring(0, param.length-1);
                    }
                    if (params.hasOwnProperty(param)) throw new ParseError(this.peek(-1), `Duplicate parameter '${param}'`);

                    params[param] = {jsName};

                    if (spread===true) {
                        spread = param;
                    } else {
                        if (this.matchText('=')) params[param].default = this.parseValue();
                        else if (this.matchText('?')) params[param].default = '';
                    }
                };

                let param = paramToken.text;
                addParam(param);
                while(this.matchText(",")) {
                    param = this.require(this.matchType('identifier')).text;
                    addParam(param);
                }
            }
            this.require(this.matchText(')'));
        }

        let def = this.vars[name] = this.require(this.tryCaptureStatementOrBlock());
        def.params = params;
        def.spread = spread;
        return true;
    }

    async tryInclude() {
        if (!this.matchText('include')) return false;

        let newUrl, nameToken = this.matchType('identifier');
        if (nameToken) {
            newUrl = `templates/${nameToken.text}.wt`;
        }
        else {
            nameToken = this.require(this.matchType('string'));

            let name = this.evalString(nameToken.text, nameToken);
            let idx = this.currentUrl.lastIndexOf('/');
            let base = idx>=0 ? this.currentUrl.substr(0, idx+1) : '';
            newUrl = base + name;
        }

        let runner = await loadInclude(newUrl, nameToken, this.context);

        for(let child of runner.parent.children) {
            this.parent.appendChild(child.cloneNode(true));   
        }

        Object.assign(this.vars, runner.vars);

        return true;
    }

    async tryIf() {
        if (!this.matchText('if')) return false;

        let ignoreRest = false;

        while(true) {

            let jsToken = this.require(this.matchType('js'));
            let condition = ignoreRest ? undefined : !!this.evalJs(jsToken.text, jsToken);

            if (condition===true) {
                this.require(await this.tryRunStatementOrBlock());
                ignoreRest = true;
            } else {
                this.require(await this.trySkipStatementOrBlock());
            }

            if (this.matchText('else')) {
                if (this.matchText('if')) {
                    continue;
                }
                if (condition===false) {
                    this.require(await this.tryRunStatementOrBlock());
                }
                else {
                    this.require(await this.trySkipStatementOrBlock());
                }
            }
            break;
        }
        return true;
    }

    async tryFor() {
        if (!this.matchText('for')) return false;

        let varName = this.require(this.matchType('identifier')).text;

        this.require(this.matchText('in'));

        let jsToken = this.require(this.matchType('js'));
        let items = this.evalJs(jsToken.text, jsToken);

        let block = this.require(this.tryCaptureStatementOrBlock());

        for(let item of items) {
            await this.yieldWork();
            await block.run(this.parent, this.context, {[varName]: item});
        }
        return true;
    }

    tryRun() {
        if (!this.matchText('run')) return false;

        let jsToken = this.require(this.matchType('js'));
        this.require(this.matchType('eol'));

        this.evalJs(jsToken.text, jsToken, this.parent);

        return true;
    }

    runSelector() {
        let selector = [];
        while(this.peek().type !== 'indent' && this.peek().type !== 'eol' && this.peek(1).text !== '=') {
            let strToken = this.matchType('string');
            if (strToken) selector.push(this.evalString(strToken.text, strToken));
            else selector.push(this.tokens[this.tokenIndex++].text);
        }
        return selector.join(' ');
    }

    tryCss() {
        if (!this.matchText('css')) return false;
        this.runCssRules('');
        return true;
    }

    runCssRules(prefix) {
        let selectorToken = this.peek();
        let selector = prefix + this.runSelector();

        let rules = '';

        while(true) {
            if (this.matchType('eol')) break;
            let prop = this.parseValue();
            this.require(this.matchText('='));
            let value = this.parseValue();
            rules += `\t${prop}: ${value};\n`;
        }

        if (this.matchType('indent')) {
            while(true) {
                if (this.matchType('dedent')) break;

                if (this.peek(1).text === '=') {
                    let prop = this.parseValue();
                    this.require(this.matchText('='));
                    let value = this.parseValue();
                    this.require(this.matchType('eol'));
                    rules += `\t${prop}: ${value};\n`;
                }
                else {
                    if (this.matchText('&')) this.runCssRules(selector);
                    else this.runCssRules(selector+" ");
                }
            }
        }

        if (rules) {
            if (selector==='') throw new ParseError(selectorToken, "CSS selector expected")
            this.stylesheet.push(`${selector} {\n${rules}}\n`);
        }
    }

    tryHtml() {
        if (!this.matchText('html')) return false;
        let htmlToken = this.tokens[this.tokenIndex];
        let html = this.parseValue();
        this.require(this.matchType('eol'));

        let topE = document.createElement('div');
        topE.innerHTML = html;
        this.parent.appendChild(topE);
        htmlToken.lastElement = topE;
        return true;
    }

    async tryLiteral() {
        let stringToken = this.matchType("string");
        if (stringToken) {
            let el = document.createTextNode(this.evalString(stringToken.text, stringToken));
            this.parent.appendChild(el);
            this.require(this.matchType('eol'));
            return true;
        }

        let jsToken = this.matchType("js");
        if (jsToken) {
            let result = this.evalJs(jsToken.text, jsToken);
            if (result instanceof Captured) {
                await result.run(this.parent, this.context, undefined, jsToken);
                jsToken.lastElement = this.parent.lastChild;
            }
            else if (result!=null) {
                let el = document.createTextNode(result);
                this.parent.appendChild(el);
            }
            this.require(this.matchType('eol'));
            return true;
        }

        return false;
    }

    async tryNode() {
        let tagToken = this.matchType('identifier');
        if (!tagToken) return false;

        let args = {};

        let tagClasses = tagToken.text.split('.');
        let tag = tagClasses[0] || 'div';
        if (tagClasses.length>1) {
            args.class = tagClasses.slice(1).join(' ');
        }
        
        let define = (tag[0] !== tag[0].toLowerCase()) ? (this.vars[tag] || false) : undefined;
        if (define===false) throw new ParseError(this.peek(-1), `No such custom element '${tag}'`);

        // Attributes
        if (define && define.spread != null) args[define.spread] = {};
        while(true) {
            let nameToken = this.matchType('identifier');
            if (!nameToken) break;
            if (nameToken.text==='...') {
                // The spread operator
                let jsToken = this.require(this.matchType('js'));
                let argsObj = this.evalJs(jsToken.text, jsToken);
                if (typeof argsObj !== 'object' || !argsObj) throw new ParseError(jsToken, `Spread operator this.requires JavaScript to return an object`);
                for(let k in argsObj) {
                    setArg(define, args, k, argsObj[k], tag, jsToken);
                }
            }
            else {
                if (!this.matchText('=')) {
                    // Backtrack one token. This looks like it's a 'content' statement.
                    this.tokenIndex--;
                    break;
                }
                setArg(define, args, nameToken.text, this.parseValue(), tag, nameToken);
            }
        }

        if (define) {
            // A custom element.

            if (this.peek().type === 'eol' && this.peek(1).type === 'indent' && this.peek(2).type === 'identifier' && this.peek(3).text === '=') {
                // Parse a list of named content blocks.
                this.require(this.matchType('eol'));
                this.require(this.matchType('indent'));

                while(true) {
                    let nameToken = this.matchType('identifier');
                    if (!nameToken) break;
                    this.require(this.matchText('='));
                    let value = this.require(this.tryCaptureStatementOrBlock());
                    setArg(define, args, nameToken.text, value, tag, nameToken);
                }

                this.require(this.matchType('dedent'));
            }
            else {
                let captured = this.tryCaptureStatementOrBlock();
                if (captured) {
                    // A single 'content' block (or line)
                    setArg(define, args, 'content', captured, tag, tagToken);
                }
                else {
                    this.matchType('eol');
                }
            }

            // Copy in default arguments, and check if all this.required parameters have been provided.
            for(let param in define.params) {
                let info = define.params[param];
                if (!args.hasOwnProperty(info.jsName)) {
                    if (info.hasOwnProperty('default')) {
                        args[info.jsName] = info.default;
                    } else {
                        throw new ParseError(this.peek(), `Custom element '${tag}' expects a '${param}' attribute`)
                    }
                }
            }

            let runner = await define.run(this.parent, this.context, args, tagToken);
            tagToken.lastElement = this.parent.lastChild;
        }
        else {
            // A DOM element
            let el = args.xmlns ? document.createElementNS(args.xmlns, tag) : document.createElement(tag)
            for(let key in args) {
                let value = args[key];
                if (typeof value === 'function' || typeof value === 'boolean') el[key] = value;
                else el.setAttribute(key, value);
            }

            let oldParent = this.parent;
            this.parent = el;
            try {
                await this.tryRunStatementOrBlock();
            } finally {
                this.parent = oldParent;
            }

            this.parent.appendChild(el);
            tagToken.lastElement = el;
        }
        
        return true;
    }

    async yieldWork() {
        // Yield every 10ms
        let time = +new Date();
        if (!this.context.lastYieldTime) this.context.lastYieldTime = time;
        if (time > this.context.lastYieldTime + 10) {
            this.context.lastYieldTime = time;
            await new Promise(function(resolve){
                setTimeout(resolve,0);
            });
            if (this.context.cancelled) {
                throw new ParseCancelled();
            }
        }
    }


    async tryBlock() {
        if (!this.matchType('indent')) return false;
        await this.yieldWork();
        while (a