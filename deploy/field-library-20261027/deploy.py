"""Frontend-only deployment; run on the registry server. Snapshots remain private."""
import hashlib,json,os,pathlib,subprocess,sys,urllib.request
os.umask(0o077)
root=pathlib.Path('/opt/reestr-docs/releases/field-library-20261027')
name='reestr-docs-marketplace-frontend-1'
expected_image='sha256:1b45ce205138018642fd023ce63b465908540a73dca82fb82cf7feab621ec018'
expected_html='aa85220735663b6a15ca049b54902feb62eb0ca354552f65352e571550340da4'
image='reestr-docs-marketplace-frontend:field-library-20261027'
html_path='/usr/share/nginx/html/legacy/index.html'
def read(cmd):return subprocess.check_output(cmd,text=True)
def inspect(n):return json.loads(read(['docker','inspect',n]))[0]
def save(n,value):
 p=root/n;p.write_text(json.dumps(value,indent=2));p.chmod(0o600)
def command(info,overlay):
 labels=info['Config']['Labels']
 cmd=['docker','compose','--project-name',labels['com.docker.compose.project'],'--project-directory',labels['com.docker.compose.project.working_dir'],'--env-file','/opt/reestr-docs/deploy/production/env.production']
 for f in labels['com.docker.compose.project.config_files'].split(','):cmd+=['-f',f]
 return cmd+['-f',str(root/overlay)]
def up(info,overlay):subprocess.run(command(info,overlay)+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120','frontend'],check=True)
if len(sys.argv)>1 and sys.argv[1]=='rollback':
 before=json.loads((root/'before.private.json').read_text());up(before,'rollback.private.json');print('Frontend rollback complete');raise SystemExit()
assert not (root/'before.private.json').exists(),'Deployment snapshot exists; inspect before repeating'
before=inspect(name)
assert before['Image']==expected_image,'Frontend changed since review'
assert read(['docker','exec',name,'sha256sum',html_path]).split()[0]==expected_html,'Published HTML changed since review'
assert json.loads((root/'browser.json').read_text())['status']=='passed'
others={n:inspect(n)['Id'] for n in read(['docker','ps','--format','{{.Names}}']).splitlines() if n!=name}
save('before.private.json',before)
env=dict(item.split('=',1) for item in before['Config']['Env'])
for filename,tag in [('apply.private.json',image),('rollback.private.json',expected_image)]:save(filename,{'services':{'frontend':{'image':tag,'environment':env,'command':before['Config']['Cmd']}}})
config=json.loads(read(command(before,'apply.private.json')+['config','--format','json']))['services']['frontend']
assert config['image']==image
for key,value in env.items():assert config['environment'][key]==value
(root/'Dockerfile').write_text('FROM '+before['Config']['Image']+'\nCOPY --chmod=644 index.html '+html_path+'\n')
(root/'.dockerignore').write_text('**\n!Dockerfile\n!index.html\n')
subprocess.run(['docker','build','--pull=false','-t',image,str(root)],check=True)
try:
 up(before,'apply.private.json')
 now=inspect(name);assert now['State']['Health']['Status']=='healthy'
 assert dict(item.split('=',1) for item in now['Config']['Env'])==env
 local_hash=hashlib.sha256((root/'index.html').read_bytes()).hexdigest()
 assert read(['docker','exec',name,'sha256sum',html_path]).split()[0]==local_hash
 with urllib.request.urlopen('https://reestr.navrotsky.ru/legacy/index.html',timeout=30) as response:assert hashlib.sha256(response.read()).hexdigest()==local_hash
 health=json.load(urllib.request.urlopen('https://reestr.navrotsky.ru/api/v1/health/ready',timeout=20));assert health['status']=='ready'
 for n,container_id in others.items():assert inspect(n)['Id']==container_id,'Unrelated container changed: '+n
 result={'status':'deployed','frontendImage':now['Image'],'previousFrontendImage':expected_image,'htmlSha256':local_hash,'health':health,'settingsPreserved':True,'otherContainersUnchanged':True}
 save('deployment-result.json',result);print(json.dumps(result))
except Exception:
 up(before,'rollback.private.json');raise
