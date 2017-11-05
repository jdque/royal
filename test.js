let {HSM, s, only} = require('./royal.js');

let tree =
    s('LIGHT', ['red', 'yellow', 'green'], [
        s('CAR', ['forward', 'reverse', 'brake']),
        s('PERSON', ['walk', 'idle'], [
            s('DIR', ['left', 'right'])
        ]),
        only('green', [
            s('TIMER', ['on', 'off'])
        ])
    ]);

let hsm = HSM.create(tree);

hsm.configure({
    debug: true,
    requireHandler: true
});

let ctx = hsm.context;

ctx.when('LIGHT', 'red', (ctx) => {
    ctx.set('green');
});

ctx.when('LIGHT', 'yellow', (ctx) => {
    ctx.set('red');
});

ctx.when('LIGHT', 'green', (ctx) => {
    ctx.when('CAR', 'forward', (ctx) => {
        ctx.set('brake');
    });

    ctx.when('CAR', 'brake', (ctx) => {
        ctx.ask('PERSON', 'walk')
    });

    ctx.when('PERSON', 'walk', (ctx) => {
    });

    ctx.when('PERSON', 'idle', (ctx) => {
    });

    ctx.tell('CAR', 'forward');
    ctx.tell('PERSON', 'idle');

    ctx.set('yellow');
});

ctx.when('LIGHT', {'*' : '*'}, (guard) => {
    console.log('----')
    guard.proceed();
});

ctx.tell('LIGHT', 'green');