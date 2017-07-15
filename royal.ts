type State      = string;
type Transition = {[name: string]: State};
type EnterFunc  = (hsm: HSM, data?: any) => void;
type UpdateFunc = (hsm: HSM, delta: number) => void;
type ExitFunc   = () => void;
type GuardFunc  = (guard: Guard) => void;

interface HSMConfig {
    debug: boolean;
    requireHandler: boolean;
}

interface Handler {
    enter: EnterFunc;
    update: UpdateFunc;
    exit: ExitFunc;
}

interface Guard {
    proceed: () => void;
}

interface Wrapper {
    name: string;
    enter: (state: State) => EnterReq;
    exit: (state: State) => ExitReq;
    between: (from: State, to: State) => BetweenReq;
}

interface Request {
    __type: 'enter' | 'exit' | 'between';
}

interface EnterReq extends Request {
    __type: 'enter';
    name: string;
    state: State;
}

interface ExitReq extends Request {
    __type: 'exit';
    name: string;
    state: State;
}

interface BetweenReq extends Request {
    __type: 'between';
    name: string;
    from: State;
    to: State;
}

function isEnterReq(req: Request): req is EnterReq {
    return req.__type === 'enter';
}

function isExitReq(req: Request): req is ExitReq {
    return req.__type === 'exit';
}

function isBetweenReq(req: Request): req is BetweenReq {
    return req.__type === 'between';
}

function isHandler(obj: any): obj is Handler {
    return 'enter' in obj && 'exit' in obj;
}

function makeTransition(name: string, state: State): Transition {
    let transition = {};
    transition[name] = state;
    return transition;
}

function unpack<T>(obj: {[key: string]: T}): [string, T] {
    let key = Object.keys(obj)[0];
    let value = obj[key];
    return [key, value];
}

class Node {
    readonly name: string;
    readonly states: State[];
    readonly children: Node[];
    readonly childMap: {[name: string]: Node};

    constructor(name: string, states: State[], children: Node[] = []) {
        this.name = name;
        this.states = states;
        this.children = children;
        this.childMap = {};
        for (let child of this.children) {
            this.childMap[child.name] = child;
        }
    }

    getChild(name: string): Node {
        return this.childMap[name];
    }

    hasState(state: State): boolean {
        return this.states.indexOf(state) >= 0;
    }
}

export class HSM {
    private parent: HSM;
    private node: Node;
    private depth: number;
    private config: HSMConfig;
    private nodeOf: {[name: string]: Node};
    private stateOf: {[name: string]: State};
    private handlerOf: {[name: string]: {[state: string]: Handler}};
    private guardOf: {[name: string]: GuardFunc}

    private constructor(node: Node, parent?: HSM) {
        this.parent = parent;
        this.node = node;
        this.depth = parent ? parent.depth + 1 : 0;
        this.config = parent ? parent.config : {
            debug: false,
            requireHandler: false
        };
        this.nodeOf = {};
        this.stateOf = {};
        this.handlerOf = {};
        this.guardOf = {};

        for (let child of node.children) {
            this.initChild(child);
        }
    }

    static create(node: Node | Node[]) {
        let nodes = node instanceof Array ? node : [node];
        let sentinel = new Node('__root', [], nodes);
        let hsm = new HSM(sentinel, null);

        return hsm;
    }

    private initChild(node: Node) {
        let name = node.name;
        this.nodeOf[name] = node;
        this.stateOf[name] = null;
        this.handlerOf[name] = {};
        this.guardOf[name] = null;
    }

    private execTransition(target: Node, newState: State, data: any) {
        let oldState = this.stateOf[target.name];
        if (oldState) {
            let oldHandler = this.handlerOf[target.name][oldState];
            if (oldHandler && oldHandler.exit) {
                oldHandler.exit();
            }
        }

        if (this.config.debug) {
            let indent = new Array(this.depth + 1).join('    ');
            console.log(`${indent}${target.name} => ${newState}`);
        }

        this.stateOf[target.name] = newState;
        let newHandler = this.handlerOf[target.name][newState];
        if (newHandler) {
            newHandler.enter(new HSM(target, this), data);
        }
        else {
            if (this.config.requireHandler) {
                throw new Error(`No handler registered for: ${target.name} => ${newState}`)
            }
        }
    }

    configure(config: Partial<HSMConfig>) {
        if ('debug' in config) {
            this.config.debug = config.debug;
        }
        if ('requireHandler' in config) {
            this.config.requireHandler = config.requireHandler;
        }
    }

    get(name: string): Wrapper {
        return {
            name,
            enter: (state: State): EnterReq => {
                return { __type: 'enter', name, state };
            },
            exit: (state: State): ExitReq => {
                return { __type: 'exit', name, state };
            },
            between: (from: State, to: State): BetweenReq => {
                return { __type: 'between', name, from, to };
            }
        }
    }

    on(request: EnterReq | ExitReq | BetweenReq, handler: Handler | EnterFunc | GuardFunc): void {
        if (isEnterReq(request)) {
            let transition = makeTransition(request.name, request.state);
            this.when(transition, handler as Handler | EnterFunc);
        }
        if (isExitReq(request)) {

        }
        if (isBetweenReq(request)) {

        }
    }

    when(transition: Transition, handler: Handler | EnterFunc): void {
        let [name, state] = unpack(transition);
        let target = this.nodeOf[name];

        if (!target) {
            throw new Error(`Name doesn't exist in this context: ${name}`);
        }
        else if (!target.hasState(state)) {
            throw new Error(`${name} doesn't have state: ${state}`);
        }

        let useHandler: Handler = null;
        if (isHandler(handler)) {
            useHandler = handler;
        }
        else if (typeof handler === 'function') {
            useHandler = {
                enter: handler,
                update: (hsm: HSM, delta: number) => {},
                exit: () => {}
            };
        }
        this.handlerOf[target.name][state] = useHandler;
    }

    tell(transition: Transition, data?: any): void {
        let [name, state] = unpack(transition);
        let target = this.nodeOf[name];

        if (!target) {
            throw new Error(`Name doesn't exist in this context: ${name}`);
        }
        if (!target.hasState(state)) {
            throw new Error(`${target.name} doesn't have state: ${state}`);
        }

        let guardFunc = this.guardOf[name];
        if (guardFunc) {
            let guard = {
                proceed: () => { this.execTransition(target, state, data); }
            };
            guardFunc(guard);
            return;
        }

        this.execTransition(target, state, data);
    }

    ask(transition: Transition, data?: any): void {
        if (!this.parent) {
            throw new Error("Current context has no parent");
        }

        this.parent.tell(transition, data);
    }

    set(transition: Transition | State, data?: any): void {
        if (typeof transition === 'object') {
            this.tell(transition, data);
        }
        else if (typeof transition === 'string') {
            this.ask({[this.node.name]: transition}, data);
        }
    }


    guard(nameToFunc: {[name: string]: GuardFunc}) {
        let [name, func] = unpack(nameToFunc);
        this.guardOf[name] = func;
    }

    update(delta: number): void {
        for (let name in this.stateOf) {
            let state = this.stateOf[name];
            if (state != null) {
                this.handlerOf[name][state].update(this, delta);
            }
        }
    }

    getHandlers(): Handler[] {
        let handlers = [];
        for (let name in this.stateOf) {
            let state = this.stateOf[name];
            if (state != null) {
                handlers.push(this.handlerOf[name][state]);
            }
        }

        return handlers;
    }

    getHandler(name: string): Handler {
        let state = this.stateOf[name];
        let handler = this.handlerOf[name][state];

        return handler;
    }
};

export function s(name: string, states: State[], children: Node[] = []) : Node {
    return new Node(name, states, children);
}

export function S(nameToStates: {[name: string]: State[]}, children: Node[] = []): Node {
    let [name, states] = unpack(nameToStates);
    return new Node(name, states, children);
}