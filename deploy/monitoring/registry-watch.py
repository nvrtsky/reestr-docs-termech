#!/usr/bin/env python3
"""Read-only public checks, run from a host other than the registry VPS."""
import concurrent.futures
import datetime
import json
import os
import pathlib
import time
import urllib.request

TARGETS = {
    'page': 'https://reestr.navrotsky.ru/',
    'api': 'https://reestr.navrotsky.ru/api/v1/health/ready',
}


def probe(name, url, opener=urllib.request.urlopen):
    start = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'ThermechRegistryWatch/1.0'})
        with opener(request, timeout=8) as response:
            body = response.read(16384)
            ok = response.status == 200
            if name == 'api':
                ok = ok and json.loads(body).get('status') == 'ready'
            else:
                ok = ok and b'<html' in body.lower()
            return {'name': name, 'ok': ok, 'status': response.status,
                    'ms': round((time.monotonic() - start) * 1000)}
    except Exception as error:
        # Never store response bodies, credentials, client IPs or query strings.
        return {'name': name, 'ok': False, 'error': type(error).__name__,
                'ms': round((time.monotonic() - start) * 1000)}


def next_state(previous, checks, now):
    healthy = all(check['ok'] for check in checks)
    failures = 0 if healthy else previous.get('consecutiveFailures', 0) + 1
    state = {'checkedAt': now, 'status': 'up' if healthy else 'down' if failures >= 3 else 'degraded',
             'consecutiveFailures': failures, 'checks': checks,
             'lastRecovery': previous.get('lastRecovery'),
             'incidentStartedAt': None if healthy else previous.get('incidentStartedAt') or now}
    if healthy and previous.get('consecutiveFailures', 0):
        state['lastRecovery'] = {'startedAt': previous.get('incidentStartedAt'),
                                 'recoveredAt': now,
                                 'failedSamples': previous['consecutiveFailures']}
    return state


def save_state(directory, state):
    directory.mkdir(parents=True, exist_ok=True)
    temp = directory / 'status.tmp'
    temp.write_text(json.dumps(state, ensure_ascii=False) + '\n')
    temp.replace(directory / 'status.json')
    log = directory / 'samples.jsonl'
    if log.exists() and log.stat().st_size >= 1024 * 1024:
        for number in (2, 1):
            source = directory / f'samples.jsonl.{number}'
            if source.exists():
                source.replace(directory / f'samples.jsonl.{number + 1}')
        log.replace(directory / 'samples.jsonl.1')
    with log.open('a') as output:
        output.write(json.dumps(state, ensure_ascii=False) + '\n')


def main():
    directory = pathlib.Path(os.environ.get('STATE_DIRECTORY', '/var/lib/termech-registry-watch'))
    try:
        previous = json.loads((directory / 'status.json').read_text())
    except (FileNotFoundError, ValueError):
        previous = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        checks = list(executor.map(lambda pair: probe(*pair), TARGETS.items()))
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    state = next_state(previous, checks, now)
    save_state(directory, state)
    print(json.dumps(state, ensure_ascii=False), flush=True)
    return 0 if state['status'] != 'down' else 1


if __name__ == '__main__':
    raise SystemExit(main())
