import importlib.util
import pathlib
import tempfile
import unittest
import json

spec = importlib.util.spec_from_file_location('watch', pathlib.Path(__file__).with_name('registry-watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)

class WatchTests(unittest.TestCase):
    def test_outage_requires_three_samples_then_records_recovery(self):
        state = {}
        for n in range(1, 4):
            state = watch.next_state(state, [{'ok': False}], f't{n}')
            self.assertEqual(state['status'], 'down' if n == 3 else 'degraded')
            self.assertEqual(state['incidentStartedAt'], 't1')
        recovered = watch.next_state(state, [{'ok': True}], 't4')
        self.assertEqual(recovered['status'], 'up')
        self.assertEqual(recovered['lastRecovery'], {'startedAt': 't1', 'recoveredAt': 't4', 'failedSamples': 3})

    def test_probe_failure_does_not_log_sensitive_exception_text(self):
        def unavailable(*args, **kwargs):
            raise TimeoutError('secret=never-log-this')
        result = watch.probe('page', 'https://example.invalid/', unavailable)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'TimeoutError')
        self.assertNotIn('secret', json.dumps(result))

    def test_journal_rotates_and_status_is_readable(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            (root / 'samples.jsonl').write_text('x' * 1024 * 1024)
            state = watch.next_state({}, [{'ok': True}], 't1')
            watch.save_state(root, state)
            self.assertEqual(json.loads((root / 'status.json').read_text())['status'], 'up')
            self.assertTrue((root / 'samples.jsonl.1').exists())

if __name__ == '__main__':
    unittest.main()
