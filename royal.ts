type State = string;
type Transition = {[from: string]: /*to:*/ State};

enum MachineState {
    NONE,
    ENTER,
    EXIT,
    GUARD,
    UPDATE
}

interface TransCommand {
    source: Node;
    target: Node;
    fromState: State;
    toState: State;
    data?: object;
}

interface EnterFunc<T> {
    (t: T): Partial<Handler<T>> | ExitFunc<T> | boolean | void;
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

interface Guard {
    from: string;
    cancel: () => void;
    proceed: () => void;
}

type StateEnterFunc = EnterFunc<Context>;
type StateExitFunc = ExitFunc<Context>;
type StateHandler = Handler<Context>;
type TransEnterFunc = EnterFunc<Guard>;
type TransExitFunc = ExitFunc<Guard>;
type TransHandler = Handler<Guard>;

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

function isArray(obj: any): obj is Array<any> {
    return Array.isArray(obj);
}

function isFunction(obj: any): obj is ((...args: any[]) => any) {
    return typeof obj === 'function';
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
   if (obj == null) {
       return false;
   }
   return 'enter' in obj && 'update' in obj && 'exit' in obj;
}

function isPartialHandler<T>(obj: any): obj is Partial<Handler<T>> {
    if (obj == null) {
        return false;
    }
    return 'enter' in obj || 'update' in obj || 'exit' in obj;
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

function extend<T>(base: {[key: string]: T}, ...objs: Array<{[key: string]: T}>): {[key: string]: T} {
    for (let obj of objs) {
        for (let key in obj) {
            base[key] = obj[key];
        }
    }
    return base;
}

class Node {
    readonly name: string;
    readonly states: State[];
    readonly children: Node[];
    readonly childMap: {[state: string]: {[name: string]: Node}};

    constructor(name: string, states: Array<State>, children: Array<Node|Restrictor> = []) {
        this.name = name;
        this.states = states;
        this.children = [];
        this.childMap = {};

        for (let state of this.states) {
            this.childMap[state] = {};
        }
        this.childMap['*'] = {};

        for (let child of children) {
            if (child instanceof Restrictor) {
                for (let grandChild of child.children) {
                    for (let state of child.states) {
                        if (this.childMap[state][grandChild.name]) {
                            throw new Error(`Duplicate node: ${grandChild.name}`);
                        }
                        this.childMap[state][grandChild.name] = grandChild;
                        this.children.push(grandChild);
                    }
                }
            }
            else {
                if (this.childMap['*'][child.name]) {
                    throw new Error(`Duplicate node: ${child.name}`);
                }
                this.childMap['*'][child.name] = child;
                this.children.push(child);
            }
        }
    }

    static create(name: string, states: State[], children: Node[] = []) : Node {
        return new Node(name, states, children);
    }


    hasChild(name: string, state: State): boolean {
        if (!this.hasState(state)) {
            return false;
        }
        return this.childMap[state][name] || this.childMap['*'][name] ? true : false;
    }

    hasState(state: State): boolean {
        return this.states.indexOf(state) >= 0 || state === '*';
    }

    hasTransition(from: State, to: State): boolean {
        return (this.hasState(from) || from === '*') &&
               (this.hasState(to) || to === '*');
    }

    getChild(name: string, state: State): Node {
        if (!this.hasChild(name, state)) {
            return null;
        }
        return this.childMap[state][name] || this.childMap['*'][name];
    }

    getChildren(state: State): Node[] {
        if (!this.hasState(state)) {
            return null;
        }
        let childMap = extend({}, this.childMap['*'], this.childMap[state]);
        let children = Object.keys(childMap).map(key => childMap[key]);
        return children;
    }
}

class Restrictor {
    readonly type: string = 'Restrictor';
    readonly states: State[];
    readonly children: Node[];

    constructor(states: State|State[], children: Node[] = []) {
        if (!isArray(states)) {
            states = [states];
        }
        this.states = states;
        this.children = children;
    }
}

export function s(name: string, states: Array<State>, children?: Array<Node|Restrictor>): Node {
    return new Node(name, states, children);
}

export function only(states: State|Array<State>, children?: Array<Node>): Restrictor {
    return new Restrictor(states, children);
}

class Context {
    private parent: Context;
    private node: Node;
    private state: State;
    private depth: number;
    public readonly data: object;  // TODO - make this a getter
    private config: HSMConfig;
    private machineState: MachineState;
    private nodeOf: {[name: string]: Node};
    private stateOf: {[name: string]: State};
    private handlerOf: {[name: string]: {[state: string]: StateHandler}};
    private guardOf: {[name: string]: {[from: string]: {[to: string]: TransHandler}}};
    private queueOf: {[name: string]: Array<TransCommand>};
    private contextOf: {[name: string]: Context};

    constructor(node: Node, parent: Context = null, state: State = '*', data: object = {}) {
        this.parent = parent;
        this.node = node;
        this.state = state;
        this.data = data;
        this.depth = parent ? parent.depth + 1 : 0;
        this.config = parent ? parent.config : null;
        this.machineState = MachineState.NONE;
        this.nodeOf = {};
        this.stateOf = {};
        this.handlerOf = {};
        this.guardOf = {};
        this.queueOf = {};
        this.contextOf = {};

        let children = this.node.getChildren(this.state);
        for (let child of children) {
            this.initChild(child);
        }
    }

    private initChild(node: Node): void {
        let name = node.name;
        this.nodeOf[name] = node;
        this.stateOf[name] = null;
        this.handlerOf[name] = {};
        this.guardOf[name] = {};
        this.queueOf[name] = [];
        this.contextOf[name] = null;
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

    private execTransition(transCommand: TransCommand): void {
        let {source, target, fromState, toState, data} = transCommand;

        if (fromState) {
            let oldHandler = this.handlerOf[target.name][fromState];
            if (oldHandler && oldHandler.exit) {
                //--------
                this.machineState = MachineState.EXIT;
                oldHandler.exit();
                this.contextOf[target.name] = null;
                this.machineState = MachineState.NONE;
                //--------
            }
        }

        let newHandler = this.handlerOf[target.name][toState];
        if (!newHandler && this.config.requireHandler) {
            throw new Error(`No handler registered for: ${target.name} => ${toState}`)
        }

        if (this.config.debug) {
            let indent = new Array(this.depth + 1).join('    ');
            console.log(`${indent}${target.name} => ${toState}`);
        }

        //--------
        this.machineState = MachineState.ENTER;
        let context = new Context(target, this, toState, data);
        this.contextOf[target.name] = context;
        this.stateOf[target.name] = toState;
        let enterRes = newHandler.enter ? newHandler.enter(context) : null;
        this.machineState = MachineState.NONE;
        //--------

        if (isPartialHandler(enterRes)) {
            newHandler.update = enterRes.update || null;
            newHandler.exit = enterRes.exit || null;
        }
        else if (isFunction(enterRes)) {
            newHandler.exit = enterRes;
        }
    }

    private execGuard(transCommand: TransCommand): void {
        let {source, target, fromState, toState, data} = transCommand;

        let fromGuards = this.guardOf[target.name];
        let toGuards = fromGuards[fromState] || fromGuards['*'];
        let handler = toGuards[toState] || toGuards['*'];
        let fromName =
            source === target    ? '__self__'   :
            source === this.node ? '__parent__' : source.name;
        let guard: Guard = {
            from: fromName,
            cancel: () => {
                //TODO
            },
            proceed: () => {
                if (handler.exit) {
                    //--------
                    this.machineState = MachineState.EXIT;
                    handler.exit();
                    this.machineState = MachineState.NONE;
                    //--------
                }

                let queue = this.queueOf[target.name];
                if (queue.length > 0) {
                    this.execTransition(transCommand);
                }
                else {
                    queue.push(transCommand);
                    this.execTransition(transCommand);
                    queue.shift();
                    this.run(target);
                }
            }
        };

        //--------
        this.machineState = MachineState.ENTER;
        let enterRes = handler.enter ? handler.enter(guard) : null;
        this.machineState = MachineState.NONE;
        //--------

        if (enterRes === true) {
            guard.proceed();
        }
        else if (isPartialHandler(enterRes)) {
            handler.update = enterRes.update || null;
            handler.exit = enterRes.exit || null;
        }
        else if (isFunction(enterRes)) {
            handler.exit = enterRes;
        }
    }

    private execState(transCommand: TransCommand): void {
        let {source, target, fromState, toState, data} = transCommand;

        if (this.stateOf[target.name] !== fromState) {
            throw new Error('State of ${target.name} is inconsistent');
        }

        if (this.isGuarded(target, fromState, toState)) {
            this.execGuard(transCommand);
        }
        else {
            this.execTransition(transCommand);
        }
    }

    private run(target: Node): void {
        let queue = this.queueOf[target.name];
        while (queue.length > 0) {
            let command = queue[0];
            this.execState(command);
            queue.shift();
        }
    }

    private schedule(source: Node, target: Node, fromState: State, toState: State, data?: object): void {
        if (!target) {
            throw new Error(`Name doesn't exist in state ${this.state}: ${target.name}`);
        }
        if (!target.hasState(toState)) {
            throw new Error(`${target.name} doesn't have state: ${toState}`);
        }

        let transCommand: TransCommand = {source, target, fromState, toState, data};

        let queue = this.queueOf[target.name];
        if (queue.length <= 1) {
            queue.push(transCommand);
        }
        else if (queue.length === 2) {
            queue[1] = transCommand;
        }

        if (queue.length === 1 && this.machineState !== MachineState.UPDATE) {
            this.run(target);
        }
    }

    tell(name: string, state: State, data?: object): void {
        let source = this.node;
        let target = this.nodeOf[name];
        let fromState = this.stateOf[name];
        let toState = state;

        this.schedule(source, target, fromState, toState, data);
    }

    ask(name: string, state: State, data?: object): void {
        let source = this.node;
        let target = this.parent.nodeOf[name];
        let fromState = this.parent.stateOf[name];
        let toState = state;

        this.parent.schedule(source, target, fromState, toState, data);
    }

    set(state: State, data?: object): void {
        let source = this.node;
        let target = this.node;
        let fromState = this.parent.stateOf[this.node.name];
        let toState = state;

        this.parent.schedule(source, target, fromState, toState, data);
    }

    when(name: string, state: State, handlerOrFunc: Partial<StateHandler> | StateEnterFunc): Context;
    when(name: string, transition: Transition, handlerOrFunc: Partial<TransHandler> | TransEnterFunc): Context;
    when(name: string, stateOrTransition: any, handlerOrFunc: any): Context {
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
            if (isPartialHandler(handlerOrFunc)) {
                handler = {
                    enter: handlerOrFunc.enter,
                    update: handlerOrFunc.update,
                    exit: handlerOrFunc.exit,
                };
            }
            else if (isFunction(handlerOrFunc)) {
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
            if (isPartialHandler(handlerOrFunc)) {
                handler = {
                    enter: handlerOrFunc.enter,
                    update: handlerOrFunc.update,
                    exit: handlerOrFunc.exit,
                };
            }
            else if (isFunction(handlerOrFunc)) {
                handler = {
                    enter: <StateEnterFunc>handlerOrFunc,
                    update: null,
                    exit: null
                };
            }

            this.handlerOf[target.name][state] = handler;
        }

        return this;
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
        for (let name in this.contextOf) {
            if (!this.contextOf[name]) {
                continue;
            }
            this.contextOf[name].update(delta);
        }

        if (!this.parent) {
            return;
        }

        let handler = this.parent.handlerOf[this.node.name][this.state];
        if (!handler || !handler.update) {
            return;
        }

        //--------
        this.machineState = MachineState.UPDATE;
        handler.update(this, delta);
        this.machineState = MachineState.NONE;
        //--------

        if (this.parent.queueOf[this.node.name].length > 0) {
            this.parent.run(this.node);
        }
    }

    configure(config: HSMConfig): void {
        this.config = config;

        for (let name in this.contextOf) {
            if (!this.contextOf[name]) {
                continue;
            }
            this.contextOf[name].configure(config);
        }
    }
}

export interface HSMConfig {
    debug: boolean;
    requireHandler: boolean;
}

export class HSM {
    private static ROOT_NAME = '__sentinel__';
    public readonly context: Context;
    public readonly config: HSMConfig;

    private constructor(nodes: Node[]) {
        let sentinel = new Node(HSM.ROOT_NAME, [], nodes);
        this.context = new Context(sentinel);
        this.config = {
            debug: false,
            requireHandler: false
        };
        this.context.configure(this.config);
    }

    static create(...nodes: Node[]): HSM {
        return new HSM(nodes);
    }

    configure(config: Partial<HSMConfig>): void {
        if ('debug' in config) {
            this.config.debug = config.debug;
        }
        if ('requireHandler' in config) {
            this.config.requireHandler = config.requireHandler;
        }
        this.context.configure(this.config);
    }
}

export interface FSMConfig {
    debug: boolean;
    requireHandler: boolean;
}

export class FSM {
    private static ROOT_NAME = '__fsm__';
    private hsm: HSM;

    private constructor(states: State[]) {
        this.hsm = HSM.create(new Node(FSM.ROOT_NAME, states, []));
    }

    static create(states: State[] | {[state: string]: Partial<StateHandler> | StateEnterFunc}): FSM {
        if (isArray(states)) {
            return new FSM(states);
        }
        else {
            let keyStates = Object.keys(states);
            let fsm = new FSM(keyStates);
            for (let state of keyStates) {
                fsm.when(state, states[state]);
            }
            return fsm;
        }
    }

    configure(config: Partial<FSMConfig>): FSM {
        let hsmConfig: Partial<HSMConfig> = {};
        if ('debug' in config) {
            hsmConfig.debug = config.debug;
        }
        if ('requireHandler' in config) {
            hsmConfig.requireHandler = config.requireHandler;
        }
        this.hsm.configure(hsmConfig);

        return this;
    }

    set(state: State, data?: object): void {
        this.hsm.context.tell(FSM.ROOT_NAME, state, data);
    }

    when(state: State, handlerOrFunc: Partial<StateHandler> | StateEnterFunc): FSM;
    when(transition: Transition, handlerOrFunc: Partial<TransHandler> | TransEnterFunc): FSM;
    when(stateOrTransition: any, handlerOrFunc: any): FSM {
        this.hsm.context.when(FSM.ROOT_NAME, stateOrTransition, handlerOrFunc);
        return this;
    }

    update(delta: number): void {
        this.hsm.context.update(delta);
    }
}