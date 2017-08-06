let {HSM, s} = require('./royal.js');

let tree =
    s('LIGHT', ['red', 'yellow', 'green'], [
        s('CAR', ['forward', 'reverse', 'brake']),
        s('PERSON', ['walk', 'idle'], [
            s('DIR', ['left', 'right'])
        ])
    ]);

let hsm = HSM.create(tree);

hsm.configure({
    debug: true,
    requireHandler: true
});

hsm.when('LIGHT', 'red', (hsm, data) => {
    setTimeout(() => hsm.set('green'), 2000);
});

hsm.when('LIGHT', 'yellow', (hsm, data) => {
    setTimeout(() => hsm.set('red'), 1000);
});

hsm.when('LIGHT', 'green', (hsm, data) => {
    hsm.when('CAR', 'forward', (hsm, data) => {
        setTimeout(() => hsm.set('brake'), 1000);
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

    setTimeout(() => hsm.set('yellow'), 2000);
});

hsm.when('LIGHT', {'*' : '*'}, (guard, data) => {
    console.log('----')
    guard.proceed();
});

hsm.tell('LIGHT', 'green');