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

hsm.when('LIGHT', 'red', (hsm, data) => {
    hsm.set('green');
});

hsm.when('LIGHT', 'yellow', (hsm, data) => {
    hsm.set('red');
});

hsm.when('LIGHT', 'green', (hsm, data) => {
    hsm.when('CAR', 'forward', (hsm, data) => {
        hsm.set('brake');
    });

    hsm.when('CAR', 'brake', (hsm, data) => {
        hsm.ask('PERSON', 'walk')
    });

    hsm.when('PERSON', 'walk', (hsm, data) => {
    });

    hsm.when('PERSON', 'idle', (hsm, data) => {
    });

    hsm.tell('CAR', 'forward');
    hsm.tell('PERSON', 'idle');

    hsm.set('yellow');
});

hsm.when('LIGHT', {'*' : '*'}, (guard, data) => {
    console.log('----')
    guard.proceed();
});

hsm.tell('LIGHT', 'green');