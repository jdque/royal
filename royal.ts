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
    newState: State;
    data?: object;
}

interface GuardCommand {
    source: Node;
    target: Node;
    fromState: State;
    toState: State;
    data?: object;
}

interface EnterFunc<T> {
    (t: T, data?: object): Partial<Handler<T>> | ExitFunc<T> | boolean | void;
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

type StateEnterFunc = EnterFunc<HSM>;
type StateExitFunc = ExitFunc<HSM>;
type StateHandler = Handler<HSM>;
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

interface HSMConfig {
    debug: boolean;
    requireHandler: boolean;
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

export function s(name: string, states: State[], children?: Node[]): Node {
    return new Node(name, states, children);
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
    private state: MachineState;
    private nodeOf: {[name: string]: Node};
    private stateOf: {[name: string]: State};
    private handlerOf: {[name: string]: {[state: string]: StateHandler}};
    private guardOf: {[name: string]: {[from: string]: {[to: string]: TransHandler}}};
    private queueOf: {[name: string]: Array<TransCommand>};

    private constructor(node: Node, parent?: HSM) {
        this.parent = parent;
        this.node = node;
        this.depth = parent ? parent.depth + 1 : 0;
        this.config = parent ? parent.config : {
            debug: false,
            requireHandler: false
        };
        this.state = MachineState.NONE;
        this.nodeOf = {};
        this.stateOf = {};
        this.handlerOf = {};
        this.guardOf = {};
        this.queueOf = {};

        for (let child of node.children) {
            this.initChild(child);
        }
    }

    static create(...nodes: Node[]): HSM {
        let sentinel = new Node('__root', [], nodes);
        let hsm = new HSM(sentinel, null);

        return hsm;
    }

    configure(config: Partial<HSMConfig>): HSM {
        if ('debug' in config) {
            this.config.debug = config.debug;
        }
        if ('requireHandler' in config) {
            this.config.requireHandler = config.requireHandler;
        }

        return this;
    }

    private initChild(node: Node) {
        let name = node.name;
        this.nodeOf[name] = node;
        this.stateOf[name] = null;
        this.handlerOf[name] = {};
        this.guardOf[name] = {};
        this.queueOf[name] = [];
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

    private execTransition(transCommand: TransCommand) {
        let {source, target, newState, data} = transCommand;

        let oldState = this.stateOf[target.name];
        if (oldState) {
            let oldHandler = this.handlerOf[target.name][oldState];
            if (oldHandler && oldHandler.exit) {
                this.state = MachineState.EXIT;
                oldHandler.exit();
                this.state = MachineState.NONE;
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

        this.state = MachineState.ENTER;
        let enterRes = newHandler.enter(new HSM(target, this), data);
        this.state = MachineState.NONE;

        if (isPartialHandler(enterRes)) {
            newHandler.update = enterRes.update || null;
            newHandler.exit = enterRes.exit || null;
        }
        else if (isFunction(enterRes)) {
            newHandler.exit = enterRes;
        }
    }

    private execGuard(guardCommand: GuardCommand) {
        let {source, target, fromState, toState, data} = guardCommand;

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
                    this.state = MachineState.EXIT;
                    handler.exit();
                    this.state = MachineState.NONE;
                }

                let transCommand = {
                    source: source,
                    target: target,
                    newState: toState,
                    data: data
                };

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

        this.state = MachineState.ENTER;
        let enterRes = handler.enter(guard, data);
        this.state = MachineState.NONE;

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
        let {source, target, newState, data} = transCommand;

        if (!target) {
            throw new Error(`Name doesn't exist in this context: ${name}`);
        }
        if (!target.hasState(newState)) {
            throw new Error(`${target.name} doesn't have state: ${newState}`);
        }

        let curState = this.stateOf[target.name];
        if (this.isGuarded(target, curState, newState)) {
            let guardCommand: GuardCommand = {
                source: source,
                target: target,
                fromState: curState,
                toState: newState,
                data: data
            };
            this.execGuard(guardCommand);
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

    private schedule(source: Node, target: Node, newState: State, data?: object): void {
        let transCommand: TransCommand = {source, target, newState, data};

        let queue = this.queueOf[target.name];
        if (queue.length <= 1) {
            queue.push(transCommand);
        }
        else if (queue.length === 2) {
            queue[1] = transCommand;
        }
    }

    tell(name: string, state: State, data?: object): void {
        let source = this.node;
        let target = this.nodeOf[name];
        this.schedule(source, target, state, data);

        let queue = this.queueOf[name];
        if (queue.length === 1 && this.state !== MachineState.UPDATE) {
            this.run(target);
        }
    }

    ask(name: string, state: State, data?: object): void {
        let source = this.node;
        let target = this.parent.nodeOf[name];
        this.parent.schedule(source, target, state, data);

        let queue = this.parent.queueOf[target.name];
        if (queue.length === 1 && this.parent.state !== MachineState.UPDATE) {
            this.parent.run(target);
        }
    }

    set(state: State, data?: object): void {
        let source = this.node;
        let target = this.node;
        this.parent.schedule(source, target, state, data);

        let queue = this.parent.queueOf[target.name];
        if (queue.length === 1 && this.parent.state !== MachineState.UPDATE) {
            this.parent.run(target);
        }
    }

    when(name: string, state: State, handlerOrFunc: Partial<StateHandler> | StateEnterFunc);
    when(name: string, transition: Transition, handlerOrFunc: Partial<TransHandler> | TransEnterFunc);
    when(name: string, stateOrTransition: any, handlerOrFunc: any): HSM {
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
        for (let name in this.stateOf) {
            let state = this.stateOf[name];
            if (!state) {
                continue;
            }
            let handler = this.handlerOf[name][state];
            if (!handler || !handler.update) {
                continue;
            }

            this.state = MachineState.UPDATE;
            this.handlerOf[name][state].update(this, delta);
            this.state = MachineState.NONE;

            if (this.queueOf[name].length > 0) {
                this.run(this.nodeOf[name]);
            }
        }
    }
}

interface FSMConfig {
    debug: boolean;
    requireHandler: boolean;
}

export class FSM {
    private static ROOT = "FSM";
    private hsm: HSM;

    private constructor(states: State[]) {
        this.hsm = HSM.create(s(FSM.ROOT, states, []));
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
        this.hsm.tell(FSM.ROOT, state, data);
    }

    when(state: State, handlerOrFunc: Partial<StateHandler> | StateEnterFunc);
    when(transition: Transition, handlerOrFunc: Partial<TransHandler> | TransEnterFunc);
    when(stateOrTransition: any, handlerOrFunc: any): FSM {
        this.hsm.when(FSM.ROOT, stateOrTransition, handlerOrFunc);
        return this;
    }

    update(delta: number): void {
        this.hsm.update(delta);
    }
}