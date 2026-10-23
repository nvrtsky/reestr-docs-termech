import json,pathlib,subprocess,hashlib,tarfile
root=pathlib.Path('/opt/reestr-docs/releases/section-permissions-20261023');root.mkdir(parents=True,exist_ok=True)
assert not (root/'before.private.json').exists()
with tarfile.open('/tmp/registry-section-release.tar.gz') as t:
 assert all(not p.name.startswith('/') and '..' not in pathlib.PurePosixPath(p.name).parts for p in t)
 t.extractall(root)
expected={'backend':'sha256:4108a1b7fa5ee945a37af0eac0949dae0f40d7000f6b85bffc42f1ec47a35fbd','frontend':'sha256:70ba5d94da54c63772656178f0c06434b6b3bc2b1f5b222018483fcf34557f4c'}
for service,image in expected.items():
 info=json.loads(subprocess.check_output(['docker','inspect','reestr-docs-marketplace-'+service+'-1']))[0];assert info['Image']==image
 subprocess.run(['docker','tag',image,'registry-section-base-'+service+':20261023'],check=True)
for file,sha in json.loads((root/'runtime-hashes.json').read_text()).items():
 content=subprocess.check_output(['docker','exec','reestr-docs-marketplace-backend-1','cat','dist/'+file]);assert hashlib.sha256(content).hexdigest()==sha,file
for service in expected:
 subprocess.run(['docker','build','--network','none','-f',service+'.Dockerfile','-t','reestr-docs-marketplace-'+service+':section-permissions-20261023','.'],cwd=root,check=True)
for file in json.loads((root/'runtime-hashes.json').read_text()):
 subprocess.run(['docker','run','--rm','--network','none','reestr-docs-marketplace-backend:section-permissions-20261023','node','--check','dist/'+file],check=True)
print('Candidate images built and syntax checked; production containers unchanged.')
