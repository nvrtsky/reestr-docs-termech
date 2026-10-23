"""Apply reviewed images only after runtime verification; preserve runtime settings."""
import json, os, pathlib, subprocess, sys, urllib.request
os.umask(0o077)
root=pathlib.Path('/opt/reestr-docs/releases/section-permissions-20261023')
services=['backend','frontend']
names={k:'reestr-docs-marketplace-'+k+'-1' for k in services}
expected={'backend':'sha256:4108a1b7fa5ee945a37af0eac0949dae0f40d7000f6b85bffc42f1ec47a35fbd','frontend':'sha256:70ba5d94da54c63772656178f0c06434b6b3bc2b1f5b222018483fcf34557f4c'}
def read(args):return subprocess.check_output(args,text=True)
def inspect(name):return json.loads(read(['docker','inspect',name]))[0]
def save(name,data):
 p=root/name;p.write_text(json.dumps(data,indent=2));p.chmod(0o600)
def command(info,overlay):
 labels=info['Config']['Labels']
 cmd=['docker','compose','--project-name',labels['com.docker.compose.project'],'--project-directory',labels['com.docker.compose.project.working_dir'],'--env-file','/opt/reestr-docs/deploy/production/env.production']
 for file in labels['com.docker.compose.project.config_files'].split(','):cmd+=['-f',file]
 return cmd+['-f',str(root/overlay)]
def up(info,overlay,service):subprocess.run(command(info,overlay)+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120',service],check=True)
def apply_settings(rollback=False):
 global settings_applied
 subprocess.run(['docker','cp',str(root/'settings.mjs'),names['backend']+':/app/backend/section-settings.mjs'],check=True)
 args=['docker','exec','--user','0','-e','SETTINGS_SNAPSHOT=/tmp/section-settings.private.json',names['backend'],'node','section-settings.mjs']
 if rollback:args+=['--rollback']
 subprocess.run(args,check=True)
 if not rollback:settings_applied=True
 if not rollback:subprocess.run(['docker','cp',names['backend']+':/tmp/section-settings.private.json',str(root/'settings-before.private.json')],check=True)
if len(sys.argv)>1 and sys.argv[1]=='rollback':
 if (root/'settings-before.private.json').exists():
  subprocess.run(['docker','cp',str(root/'settings-before.private.json'),names['backend']+':/tmp/section-settings.private.json'],check=True)
  apply_settings(True)
 before=json.loads((root/'before.private.json').read_text())
 for k in reversed(services):up(before[k],k+'.rollback.private.json',k)
 print('Rollback healthy');raise SystemExit()
assert (root/'runtime-checks.json').exists(),'Run converter/API checks before deployment'
assert json.loads((root/'runtime-checks.json').read_text())['status']=='passed'
assert json.loads((root/'browser-checks.json').read_text())['status']=='passed'
assert not (root/'before.private.json').exists(),'Snapshot already exists; inspect before repeating'
before={k:inspect(names[k]) for k in services}
for k in services:assert before[k]['Image']==expected[k],'Concurrent release: '+k
others={n:inspect(n)['Id'] for n in read(['docker','ps','--format','{{.Names}}']).splitlines() if n not in names.values()}
save('before.private.json',before)
for k in services:
 env=dict(item.split('=',1) for item in before[k]['Config']['Env'])
 image='reestr-docs-marketplace-'+k+':section-permissions-20261023'
 settings={'image':image,'environment':env}
 if k=='backend':settings['command']=['node','dist/server.js'] # No migration step in this release.
 save(k+'.apply.private.json',{'services':{k:settings}})
 save(k+'.rollback.private.json',{'services':{k:{'image':before[k]['Image'],'environment':env,'command':before[k]['Config']['Cmd']}}})
 config=json.loads(read(command(before[k],k+'.apply.private.json')+['config','--format','json']))['services'][k]
 assert config['image']==image
 for key,value in env.items():assert config['environment'][key]==value
changed=[]
settings_applied=False
try:
 for k in services:
  changed.append(k);up(before[k],k+'.apply.private.json',k)
  assert inspect(names[k])['State']['Health']['Status']=='healthy'
 apply_settings();settings_applied=True
 subprocess.run(command(before["backend"],"backend.apply.private.json")+["restart","backend"],check=True)
 up(before["backend"],"backend.apply.private.json","backend")
 for n,container_id in others.items():assert inspect(n)['Id']==container_id,'Unrelated container changed'
 health=json.load(urllib.request.urlopen('https://reestr.navrotsky.ru/api/v1/health/ready',timeout=20));assert health['status']=='ready'
 result={'status':'deployed','images':{k:inspect(names[k])['Image'] for k in services},'health':health,'unrelatedContainersUnchanged':True}
 save('deployment-result.json',result);print(json.dumps(result))
except Exception:
 if settings_applied:apply_settings(True)
 for k in reversed(changed):up(before[k],k+'.rollback.private.json',k)
 raise
