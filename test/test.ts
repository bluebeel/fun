import { basename, join } from 'path';
import { tmpdir } from 'os';
import * as execa from 'execa';
import * as assert from 'assert';
import { mkdirp, remove, readdir, readFile } from 'fs-extra';
import {
	funCacheDir,
	cleanCacheDir,
	createFunction,
	ValidationError
} from '../src';
import { generateNodeTarballUrl, installNode } from '../src/install-node';
import { generatePythonTarballUrl, installPython } from '../src/install-python';
import { LambdaError } from '../src/errors';

export function test_funCacheDir() {
	assert.equal('string', typeof funCacheDir);
}

export function test_LambdaError() {
	const err = new LambdaError({
		errorType: 'InitError',
		errorMessage: 'I crashed!',
		stackTrace: [
			'    at Object.<anonymous> (/Code/zeit/fun/test/functions/nodejs-init-error/handler.js:2:7)',
			'    at Module._compile (module.js:652:30)',
			'    at Object.Module._extensions..js (module.js:663:10)',
			'    at Module.load (module.js:565:32)',
			'    at tryModuleLoad (module.js:505:12)',
			'    at Function.Module._load (module.js:497:3)',
			'    at Module.require (module.js:596:17)',
			'    at require (internal/module.js:11:18)',
			'    at getHandler (/Library/Caches/co.zeit.fun/runtimes/nodejs/bootstrap.js:151:15)',
			'    at /Library/Caches/co.zeit.fun/runtimes/nodejs/bootstrap.js:37:23'
		]
	});
	assert.equal('InitError', err.name);
	assert.equal('I crashed!', err.message);
	assert(err.stack.includes('nodejs-init-error/handler.js'));
}

// `install-node.ts` tests
export function test_install_node_tarball_url() {
	assert.equal(
		'https://nodejs.org/dist/v8.10.0/node-v8.10.0-darwin-x64.tar.gz',
		generateNodeTarballUrl('8.10.0', 'darwin', 'x64')
	);
}

export async function test_install_node() {
	const version = 'v10.0.0';
	const dest = join(
		tmpdir(),
		`install-node-${Math.random()
			.toString(16)
			.substring(2)}`
	);
	await mkdirp(dest);
	try {
		await installNode(dest, version);
		const res = await execa(join(dest, 'bin/node'), [
			'-p',
			'process.version'
		]);
		assert.equal(res.stdout.trim(), version);
	} finally {
		// Clean up
		await remove(dest);
	}
}

// `install-python.ts` tests
export function test_install_python_tarball_url() {
	assert.equal(
		'https://python-binaries.zeit.sh/python-2.7.12-darwin-x64.tar.gz',
		generatePythonTarballUrl('2.7.12', 'darwin', 'x64')
	);
}

export async function test_install_python() {
	const version = '3.6.8';
	const dest = join(
		tmpdir(),
		`install-python-${Math.random()
			.toString(16)
			.substring(2)}`
	);
	await mkdirp(dest);
	try {
		await installPython(dest, version);
		const res = await execa(join(dest, 'bin/python'), [
			'-c',
			'import platform; print(platform.python_version())'
		]);
		assert.equal(res.stdout.trim(), version);
	} finally {
		// Clean up
		//await remove(dest);
	}
}

// Validation
export const test_lambda_properties = async () => {
	const fn = await createFunction({
		Code: {
			Directory: __dirname + '/functions/nodejs-echo'
		},
		Handler: 'handler.handler',
		Runtime: 'nodejs',
		Environment: {
			Variables: {
				HELLO: 'world'
			}
		}
	});
	assert.equal(fn.version, '$LATEST');
	//assert.equal(fn.functionName, 'nodejs-echo');
};

export const test_reserved_env = async () => {
	let err;
	try {
		await createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-echo'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs',
			Environment: {
				Variables: {
					AWS_REGION: 'foo',
					TZ: 'US/Pacific'
				}
			}
		});
	} catch (_err) {
		err = _err;
	}
	assert(err);
	assert(err instanceof ValidationError);
	assert.equal(err.name, 'ValidationError');
	assert.deepEqual(err.reserved, ['AWS_REGION', 'TZ']);
	assert.equal(
		err.toString(),
		'ValidationError: The following environment variables can not be configured: AWS_REGION, TZ'
	);
};

// Invocation
function testInvoke(fnPromise, test) {
	return async function() {
		const fn = await fnPromise();
		try {
			await test(fn);
		} finally {
			await fn.destroy();
		}
	};
}

export const test_nodejs_event = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-echo'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs'
		}),
	async fn => {
		const res = await fn.invoke({
			Payload: JSON.stringify({ hello: 'world' })
		});
		assert.equal(res.StatusCode, 200);
		assert.equal(res.ExecutedVersion, '$LATEST');
		assert.equal(typeof res.Payload, 'string');
		const payload = JSON.parse(String(res.Payload));
		assert.deepEqual(payload.event, { hello: 'world' });
	}
);

export const test_nodejs_no_payload = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-echo'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs'
		}),
	async fn => {
		const res = await fn.invoke();
		assert.equal(typeof res.Payload, 'string');
		const payload = JSON.parse(String(res.Payload));
		assert.deepEqual(payload.event, {});
	}
);

export const test_nodejs_context = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-echo'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs'
		}),
	async fn => {
		const res = await fn.invoke();
		const { context } = JSON.parse(String(res.Payload));
		assert.equal(context.logGroupName, 'aws/lambda/nodejs-echo');
		assert.equal(context.functionName, 'nodejs-echo');
		assert.equal(context.memoryLimitInMB, '128');
		assert.equal(context.functionVersion, '$LATEST');
	}
);

export const test_env_vars = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-env'
			},
			Handler: 'index.env',
			Runtime: 'nodejs'
		}),
	async fn => {
		const res = await fn.invoke();
		assert.equal(typeof res.Payload, 'string');
		const env = JSON.parse(String(res.Payload));
		assert(env.LAMBDA_TASK_ROOT.length > 0);
		assert(env.LAMBDA_RUNTIME_DIR.length > 0);
		assert.equal(env.TZ, ':UTC');
		assert.equal(env.LANG, 'en_US.UTF-8');
		assert.equal(env._HANDLER, 'index.env');
		assert.equal(env.AWS_LAMBDA_FUNCTION_VERSION, '$LATEST');
		assert.equal(env.AWS_EXECUTION_ENV, 'AWS_Lambda_nodejs');
		assert.equal(env.AWS_LAMBDA_FUNCTION_NAME, 'nodejs-env');
		assert.equal(env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE, '128');
	}
);

export const test_double_invoke_serial = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-pid'
			},
			Handler: 'index.pid',
			Runtime: 'nodejs'
		}),
	async fn => {
		let res;

		// Invoke once, will fire up a new lambda process
		res = await fn.invoke();
		assert.equal(typeof res.Payload, 'string');
		const pid = JSON.parse(String(res.Payload));
		assert.equal(typeof pid, 'number');
		assert.notEqual(pid, process.pid);

		// Invoke a second time, the same lambda process will be used
		res = await fn.invoke();
		assert.equal(typeof res.Payload, 'string');
		const pid2 = JSON.parse(String(res.Payload));
		assert.equal(pid, pid2);
	}
);

export const test_double_invoke_parallel = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-pid'
			},
			Handler: 'index.pid',
			Runtime: 'nodejs'
		}),
	async fn => {
		const [res1, res2] = await Promise.all([fn.invoke(), fn.invoke()]);
		const pid1 = JSON.parse(String(res1.Payload));
		const pid2 = JSON.parse(String(res2.Payload));
		assert.notEqual(pid1, process.pid);
		assert.notEqual(pid2, process.pid);

		// This assert always passed on my MacBook 12", but is flaky on
		// CircleCI's containers due to the second worker process not yet
		// being in an initialized state.
		// assert.notEqual(pid1, pid2);
	}
);

export const test_lambda_invoke = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-echo'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs'
		}),
	async fn => {
		const payload = await fn({ hello: 'world' });
		assert.deepEqual(payload.event, { hello: 'world' });
	}
);

// `fun` should be resilient to its runtime cache being wiped away during
// runtime. At least, in between function creations. Consider a user running
// `now dev cache clean` while a `now dev` server is running, and then the
// user does a hard refresh to re-create the Lambda functions.
interface Hello {
	event: {
		hello: string;
	};
}
export const test_clean_cache_dir_recovery = async () => {
	await cleanCacheDir();
	const fn = await createFunction({
		Code: {
			Directory: __dirname + '/functions/nodejs-echo'
		},
		Handler: 'handler.handler',
		Runtime: 'nodejs'
	});
	try {
		const payload = await fn<Hello>({ hello: 'world' });
		assert.deepEqual(payload.event, { hello: 'world' });
	} finally {
		await fn.destroy();
	}
};

// `provided` runtime
export const test_provided_bash_echo = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/provided-bash-echo'
			},
			Handler: 'handler.handler',
			Runtime: 'provided'
		}),
	async fn => {
		const payload = await fn({ hello: 'world' });
		assert.deepEqual(payload, { hello: 'world' });
	}
);

// `nodejs6.10` runtime
export const test_nodejs610_version = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-version'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs6.10'
		}),
	async fn => {
		const versions = await fn({ hello: 'world' });
		assert.equal(versions.node, '6.10.0');
	}
);

// `nodejs8.10` runtime
export const test_nodejs810_version = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-version'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs8.10'
		}),
	async fn => {
		const versions = await fn({ hello: 'world' });
		assert.equal(versions.node, '8.10.0');
	}
);

export const test_nodejs810_handled_error = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-eval'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs8.10'
		}),
	async fn => {
		let err;
		const error = 'this is a handled error';
		try {
			await fn({ error });
		} catch (_err) {
			err = _err;
		}
		assert(err);
		assert.equal(err.message, error);

		const { result } = await fn({ code: '1 + 1' });
		assert.equal(result, 2);
	}
);

export const test_nodejs810_exit_in_handler = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/nodejs-eval'
			},
			Handler: 'handler.handler',
			Runtime: 'nodejs8.10'
		}),
	async fn => {
		let err;
		try {
			await fn({ code: 'process.exit(5)' });
		} catch (_err) {
			err = _err;
		}
		assert(err);
		assert(
			err.message.includes('Process exited before completing request')
		);
	}
);

// `go1.x` runtime
export const test_go1x_echo = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/go-echo'
			},
			Handler: 'handler',
			Runtime: 'go1.x'
		}),
	async fn => {
		const payload = await fn({ hello: 'world' });
		assert.deepEqual(payload, { hello: 'world' });
	}
);

// `python` runtime
export const test_python_hello = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/python-hello'
			},
			Handler: 'hello.hello_handler',
			Runtime: 'python'
		}),
	async fn => {
		const payload = await fn({ first_name: 'John', last_name: 'Smith' });
		assert.deepEqual(payload, { message: 'Hello John Smith!' });
	}
);

// `python2.7` runtime
export const test_python27_version = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/python-version'
			},
			Handler: 'handler.handler',
			Runtime: 'python2.7'
		}),
	async fn => {
		const payload = await fn();
		assert.equal(payload['platform.python_version'], '2.7.12');
	}
);

// `python3.6` runtime
export const test_python36_version = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/python-version'
			},
			Handler: 'handler.handler',
			Runtime: 'python3.6'
		}),
	async fn => {
		const payload = await fn();
		assert.equal(payload['platform.python_version'], '3.6.8');
	}
);

// `python3.7` runtime
export const test_python37_version = testInvoke(
	() =>
		createFunction({
			Code: {
				Directory: __dirname + '/functions/python-version'
			},
			Handler: 'handler.handler',
			Runtime: 'python3.7'
		}),
	async fn => {
		const payload = await fn();
		assert.equal(payload['platform.python_version'], '3.7.2');
	}
);

// `ZipFile` Buffer support
export const test_lambda_zip_file_buffer = testInvoke(
	async () => {
		return await createFunction({
			Code: {
				ZipFile: await readFile(__dirname + '/functions/nodejs-env.zip')
			},
			Handler: 'index.env',
			Runtime: 'nodejs',
			Environment: {
				Variables: {
					HELLO: 'world'
				}
			}
		});
	},
	async fn => {
		const env = await fn();
		assert.equal(env.HELLO, 'world');
		// Assert that the `TASK_ROOT` dir includes the "zeit-fun-" prefix
		assert(/^zeit-fun-/.test(basename(env.LAMBDA_TASK_ROOT)));
	}
);

// `ZipFile` string support
export const test_lambda_zip_file_string = testInvoke(
	() =>
		createFunction({
			Code: {
				ZipFile: __dirname + '/functions/nodejs-env.zip'
			},
			Handler: 'index.env',
			Runtime: 'nodejs',
			Environment: {
				Variables: {
					HELLO: 'world'
				}
			}
		}),
	async fn => {
		const env = await fn();
		assert.equal(env.HELLO, 'world');
		// Assert that the `TASK_ROOT` dir includes the "zeit-fun-" prefix
		assert(/^zeit-fun-/.test(basename(env.LAMBDA_TASK_ROOT)));
	}
);

// `pkg` compilation support
export const test_pkg_support = async () => {
	const root = require.resolve('pkg').replace(/\/node_modules(.*)$/, '');
	const pkg = join(root, 'node_modules/.bin/pkg');
	await execa(pkg, ['-t', 'node8', 'test/pkg-invoke.js'], {
		cwd: root
	});
	const output = await execa.stdout(join(root, 'pkg-invoke'), {
		cwd: __dirname,
		stdio: ['ignore', 'pipe', 'inherit']
	});
	assert.equal(JSON.parse(output).hello, 'world');
};
