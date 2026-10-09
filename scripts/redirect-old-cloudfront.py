#!/usr/bin/env python3
"""Old-account-only CloudFront redirect. Default action is read-only plan."""
import argparse, copy, datetime, hashlib, json, os, pathlib, subprocess, time, uuid

ACCOUNT = '237145860616'
TARGET = 'https://docs.google.com/document/d/10mruhP_Th9ItMun53E-VC_UTDS9x8nxszGXRhESHU-U/edit?tab=t.0'
CODE = 'function handler(event) { return {statusCode:302,statusDescription:"Found",headers:{location:{value:' + json.dumps(TARGET) + '},"cache-control":{value:"no-store"}}}; }\n'

def check_account(actual):
    if actual != ACCOUNT:
        raise RuntimeError(f'Wrong account {actual}; only old account {ACCOUNT} is allowed.')

def redirect_config(original, arn):
    config = copy.deepcopy(original)
    config['Enabled'] = True
    for b in [config['DefaultCacheBehavior']] + config.get('CacheBehaviors', {}).get('Items', []):
        functions = [x for x in b.get('FunctionAssociations', {}).get('Items', []) if x['EventType'] != 'viewer-request']
        functions.append({'EventType': 'viewer-request', 'FunctionARN': arn})
        b['FunctionAssociations'] = {'Quantity': len(functions), 'Items': functions}
        lambdas = [x for x in b.get('LambdaFunctionAssociations', {}).get('Items', []) if x['EventType'] not in ('viewer-request', 'viewer-response')]
        b['LambdaFunctionAssociations'] = {'Quantity': len(lambdas)}
        if lambdas:
            b['LambdaFunctionAssociations']['Items'] = lambdas
    return config

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'apply', 'status', 'rollback'], nargs='?', default='plan')
    parser.add_argument('--profile', required=True)
    parser.add_argument('--state', type=pathlib.Path, default=pathlib.Path.home() / 'atlas-old-cloudfront-redirect-237145860616')
    args = parser.parse_args()
    os.umask(0o077)

    def aws(*parts):
        for attempt in range(8):
            proc = subprocess.run(['aws', *parts, '--profile', args.profile, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '10', '--cli-read-timeout', '30'], capture_output=True, text=True, timeout=75, env={**os.environ, 'AWS_MAX_ATTEMPTS': '1', 'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off'})
            if proc.returncode == 0:
                return json.loads(proc.stdout or '{}')
            if any(x in proc.stderr for x in ('Throttling', 'Rate exceeded', 'TooManyRequests')) and attempt < 7:
                delay = min(120, 10 * 2 ** attempt)
                print(f'Throttled; waiting {delay}s', flush=True)
                time.sleep(delay)
                continue
            # AccessDenied and activation errors stop the whole batch immediately.
            raise RuntimeError(proc.stderr.strip())

    check_account(aws('sts', 'get-caller-identity')['Account'])
    if args.action == 'plan':
        items = aws('cloudfront', 'list-distributions').get('DistributionList', {}).get('Items', [])
        for item in items:
            print(item['Id'], item['DomainName'], 'enabled=' + str(item['Enabled']))
        print(f'{len(items)} standard distributions; all paths, including API/node links. Disabled distributions will be enabled. Target: {TARGET}')
        return

    args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = args.state / 'running.lock'
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    def save(path, value):
        tmp = path.with_suffix(path.suffix + '.tmp')
        tmp.write_text(json.dumps(value, indent=2) + '\n')
        tmp.replace(path)
    def read(path):
        return json.loads(path.read_text())
    try:
        statefile = args.state / 'state.json'
        if not statefile.exists():
            if args.action != 'apply':
                raise RuntimeError('No saved redirect run. Run plan, then apply first.')
            items = aws('cloudfront', 'list-distributions').get('DistributionList', {}).get('Items', [])
            save(statefile, {'account': ACCOUNT, 'target': TARGET, 'function': 'atlas-old-redirect-' + uuid.uuid4().hex[:16], 'ids': [x['Id'] for x in items]})
        state = read(statefile)
        check_account(state['account'])
        if state['target'] != TARGET:
            raise RuntimeError('Saved target differs.')
        if args.action == 'status':
            for ident in state['ids']:
                dist = aws('cloudfront', 'get-distribution', '--id', ident)['Distribution']
                print(ident, dist['Status'], 'https://' + dist['DomainName'])
            return
        if args.action == 'apply':
            # Complete every original backup before submitting any distribution update.
            for ident in state['ids']:
                path = args.state / (ident + '.original.json')
                if not path.exists():
                    save(path, aws('cloudfront', 'get-distribution-config', '--id', ident))
                    print('BACKED UP', ident, flush=True)
            if not state['ids']:
                print('No distributions in saved run.'); return
            code = args.state / 'redirect.js'
            code.write_text(CODE)
            functions = aws('cloudfront', 'list-functions').get('FunctionList', {}).get('Items', [])
            # Saved ID order is immutable: preserve the original first 100.
            # Overflow uses deterministic function names and persisted per-group ARNs.
            state.setdefault('function_arns', {})
            for group in range((len(state['ids']) + 99) // 100):
                name = state['function'] if group == 0 else state['function'] + '-part-' + str(group + 1)
                if str(group) in state['function_arns']:
                    continue
                if group == 0 and state.get('arn'):
                    state['function_arns']['0'] = state['arn']
                    save(statefile, state)
                    continue
                fn = next((f for f in functions if f['Name'] == name), None)
                if fn is None:
                    fn = aws('cloudfront', 'create-function', '--name', name, '--function-config', json.dumps({'Comment': 'Old account temporary redirect', 'Runtime': 'cloudfront-js-2.0'}), '--function-code', 'fileb://' + str(code.resolve()))['FunctionSummary']
                info = aws('cloudfront', 'describe-function', '--name', name)
                aws('cloudfront', 'publish-function', '--name', name, '--if-match', info['ETag'])
                state['function_arns'][str(group)] = fn['FunctionMetadata']['FunctionARN']
                if group == 0:
                    state['arn'] = state['function_arns']['0']
                save(statefile, state)
        for index, ident in enumerate(state['ids']):
            original = read(args.state / (ident + '.original.json'))['DistributionConfig']
            current = aws('cloudfront', 'get-distribution-config', '--id', ident)
            arn = state.get('function_arns', {}).get(str(index // 100), state.get('arn'))
            applied = redirect_config(original, arn) if arn else None
            desired = applied if args.action == 'apply' else original
            if current['DistributionConfig'] == desired:
                print('UNCHANGED', ident, flush=True); continue
            expected = original if args.action == 'apply' else applied
            if current['DistributionConfig'] != expected:
                raise RuntimeError(f'{ident}: config changed outside this run; inspect before overwriting.')
            path = args.state / (ident + '.' + args.action + '.json')
            save(path, desired)
            aws('cloudfront', 'update-distribution', '--id', ident, '--if-match', current['ETag'], '--distribution-config', 'file://' + str(path.resolve()))
            print('SUBMITTED', args.action, ident, flush=True)
            time.sleep(5)
        print('Updates submitted, not yet verified deployed. State/backups:', args.state)
    finally:
        os.close(fd)
        lock.unlink()

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nInterrupted; rerun with the same state directory to resume.')
        raise SystemExit(130)
    except Exception as error:
        print('ERROR:', error)
        raise SystemExit(1)
