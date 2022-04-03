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
        if (run