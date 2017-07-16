type State = string;
type Transition = {[from: string]: /*to:*/ State};

interface EnterFunc<T> {
    (t: T, data?: object): ExitFunc<T> | boolean | void;
}

interface UpdateFunc<T> {
    (t: T, delta: number): void;
}

interface ExitFunc<T> {
    (): void;
}

interface Handler<T> {
    enter: EnterFunc<T>;
    update: UpdateFunc<T>;
    exit: ExitFunc<T>;
}

type StateEnterFunc = EnterFunc<HSM>;
type StateExitFunc = ExitFunc<HSM>;
type StateHandler = Handler<HSM>;
type TransEnterFunc = EnterFunc<Guard>;
type TransHandler = Handler<Guard>;

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

type NodeBuildFunc = (name: string, states: State[], children?: Node[]) => Node;

interface HSMConfig {
    debug: boolean;
    requireHandler: boolean;
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

function isHandler<T>(obj: any): obj is Handler<T> {
   return 'enter' in obj;
}

function isTransition(transition: any): transition is Transition {
    return typeof transition === 'object' && Object.keys(transition).length === 1;
}

function makeTransition(from: State, to: State): Transition {
    let transition = {};
    transition[from] = to;
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

    static create(name: string, states: State[], children: Node[] = []) : Node {
        return new Node(name, states, children);
    }

    getChild(name: string): Node {
        return this.childMap[name];
    }

    hasState(state: State): boolean {
        return this.states.indexOf(state) >= 0;
    }

    hasTransition(from: State, to: State): boolean {
        return (this.hasState(from) || from === '*') &&
               (this.hasState(to) || to === '*');
    }
}

export class HSM {
    private parent: HSM;
    private node: Node;
    private depth: number;
    private config: HSMConfig;
    private nodeOf: {[name: string]: Node};
    private stateOf: {[name: string]: State};
    private handlerOf: {[name: string]: {[state: string]: StateHandler}};
    private guardOf: {[name: string]: {[from: string]: {[to: string]: TransHandler}}};

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

    static build(buildFunc: (nodeBuildFunc: NodeBuildFunc) => Node): HSM {
        let tree = buildFunc(Node.create);
        return HSM.create(tree);
    }

    private initChild(node: Node) {
        let name = node.name;
        this.nodeOf[name] = node;
        this.stateOf[name] = null;
        this.handlerOf[name] = {};
        this.guardOf[name] = {};
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
        if (!newHandler && this.config.requireHandler) {
            throw new Error(`No handler registered for: ${target.name} => ${newState}`)
        }
        let enterRes = newHandler.enter(new HSM(target, this), data);
        if (typeof enterRes === 'function' && !newHandler.exit) {
            newHandler.exit = enterRes;
        }
    }

    private execGuard(target: Node, from: State, to: State, data: any) {
        let fromGuards = this.guardOf[target.name];
        let toGuards = fromGuards[from] || fromGuards['*'];
        let handler = toGuards[to] || toGuards['*'];
        let guard = {
            proceed: () => {
                if (handler.exit) {
                    handler.exit();
                }
                this.execTransition(target, to, data);
            }
        };
        let enterRes = handler.enter(guard, data);
        if (enterRes === true) {
            guard.proceed();
        }
        else if (typeof enterRes === 'function' && !handler.exit) {
            handler.exit = enterRes;
        }
    }

    private isGuarded(target: Node, from: State, to: State): boolean {
        let fromGuards = this.guardOf[target.name];
        if (!fromGuards) {
            return false;
        }
        let toGuards = fromGuards[from] || fromGuards['*'];
        if (!toGuards) {
            return false;
        }
        let handler = toGuards[to] || toGuards['*'];
        if (!handler) {
            return false;
        }

        return true;
    }

    configure(config: Partial<HSMConfig>) {
        if ('debug' in config) {
            this.config.debug = config.debug;
        }
        if ('requireHandler' in config) {
            this.config.requireHandler = config.requireHandler;
        }
    }

    when(name: string, state: State, handlerOrFunc: StateHandler | StateEnterFunc);
    when(name: string, transition: Transition, handlerOrFunc: TransHandler | TransEnterFunc);
    when(name: string, stateOrTransition: any, handlerOrFunc: any): void {
        let target = this.nodeOf[name];
        if (!target) {
            throw new Error(`Name doesn't exist in this context: ${name}`);
        }

        if (isTransition(stateOrTransition)) {
            let [from, to] = unpack(stateOrTransition);
            if (!target.hasTransition(from, to) && from !== '*') {
                throw new Error(`${name} doesn't have transition: ${from} -> ${to}`);
            }

            let handler: TransHandler = null;
            if (isHandler(handlerOrFunc)) {
                handler = <TransHandler>handlerOrFunc;
            }
            else if (typeof handlerOrFunc === 'function') {
                handler = {
                    enter: <TransEnterFunc>handlerOrFunc,
                    update: null,
                    exit: null
                };
            }

            let guards = this.guardOf[target.name];
            if (!guards[from]) {
                guards[from] = {};
            }
            guards[from][to] = handler;
        }
        else {
            let state = stateOrTransition;
            if (!target.hasState(state)) {
                throw new Error(`${name} doesn't have state: ${state}`);
            }

            let handler: StateHandler = null;
            if (isHandler(handlerOrFunc)) {
                handler = <StateHandler>handlerOrFunc;
            }
            else if (typeof handlerOrFunc === 'function') {
                handler = {
                    enter: <StateEnterFunc>handlerOrFunc,
                    update: null,
                    exit: null
                };
            }

            this.handlerOf[target.name][state] = handler;
        }
    }

    tell(name: string, state: State, data?: object): void {
        let target = this.nodeOf[name];
        if (!target) {
            throw new Error(`Name doesn't exist in this context: ${name}`);
        }
        if (!target.hasState(state)) {
            throw new Error(`${target.name} doesn't have state: ${state}`);
        }

        let curState = this.stateOf[target.name];
        if (this.isGuarded(target, curState, state)) {
            this.execGuard(target, curState, state, data);
        }
        else {
            this.execTransition(target, state, data);
        }
    }

    ask(name: string, state: State, data?: object): void {
        if (!this.parent) {
            throw new Error("Current context has no parent");
        }

        this.parent.tell(name, state, data);
    }

    set(state: State, data?: object): void {
        this.ask(this.node.name, state, data);
    }

    wrap(name: string): Wrapper {
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

    on(request: EnterReq, func: StateEnterFunc): void;
    on(request: ExitReq, func: StateExitFunc): void;
    on(request: BetweenReq, func: TransEnterFunc): void;
    on(request: Request, func: Function): void {
        if (isEnterReq(request)) {
            this.when(request.name, request.state, <StateEnterFunc>func);
        }
        else if (isExitReq(request)) {
            //TODO
        }
        else if (isBetweenReq(request)) {
            let transition = makeTransition(request.from, request.to);
            this.when(request.name, transition, <TransEnterFunc>func);
        }
    }

    update(delta: number): void {
        for (let name in this.stateOf) {
            let state = this.stateOf[name];
            if (!state) {
                continue;
            }
            let handler = this.handlerOf[name][state];
            if (!handler || !handler.update) {
                continue;
            }
            this.handlerOf[name][state].update(this, delta);
        }
    }

    getHandlers(): StateHandler[] {
        let handlers = [];
        for (let name in this.stateOf) {
            let state = this.stateOf[name];
            if (state != null) {
                handlers.push(this.handlerOf[name][state]);
            }
        }

        return handlers;
    }

    getHandler(name: string): StateHandler {
        let state = this.stateOf[name];
        let handler = this.handlerOf[name][state];

        return handler;
    }
}