import importlib.util,json,pathlib,sys,tempfile,unittest,copy
from unittest.mock import patch
path=pathlib.Path(sys.argv.pop(1)) if len(sys.argv)>1 else pathlib.Path('scripts/redirect-old-cloudfront.py')
spec=importlib.util.spec_from_file_location('redirect',path)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ResumeTest(unittest.TestCase):
 def test_resume_and_rollback(self):
  with tempfile.TemporaryDirectory() as tmp:
   folder=pathlib.Path(tmp)
   ids=[f'D{i:03}' for i in range(105)]
   original={'Enabled':True,'DefaultCacheBehavior':{}}
   configs={x: m.redirect_config(original,'old-arn') if i<100 else copy.deepcopy(original) for i,x in enumerate(ids)}
   for x in ids: (folder/(x+'.original.json')).write_text(json.dumps({'DistributionConfig':original,'ETag':'original'}))
   (folder/'state.json').write_text(json.dumps({'account':m.ACCOUNT,'target':m.TARGET,'function':'old-function','arn':'old-arn','ids':ids}))
   backups={p.name:p.read_bytes() for p in folder.glob('*.original.json')}
   functions={'old-function':'old-arn'}
   updates=[]
   def call(cmd,**kwargs):
    op=cmd[2]
    opt=lambda k:cmd[cmd.index(k)+1]
    out={}
    if op=='get-caller-identity':out={'Account':m.ACCOUNT}
    elif op=='list-functions':out={'FunctionList':{'Items':[{'Name':n,'FunctionMetadata':{'FunctionARN':a}} for n,a in functions.items()]}}
    elif op=='create-function':
     name=opt('--name');functions[name]='arn:'+name
     out={'FunctionSummary':{'FunctionMetadata':{'FunctionARN':functions[name]}}}
    elif op=='describe-function':out={'ETag':'etag'}
    elif op=='publish-function':pass
    elif op=='get-distribution-config':out={'ETag':'fresh','DistributionConfig':configs[opt('--id')]}
    elif op=='update-distribution':
     ident=opt('--id');c=json.loads(pathlib.Path(opt('--distribution-config')[7:]).read_text())
     arn=c['DefaultCacheBehavior'].get('FunctionAssociations',{}).get('Items',[{}])[0].get('FunctionARN')
     count=sum(1 for k,v in configs.items() if k!=ident and v['DefaultCacheBehavior'].get('FunctionAssociations',{}).get('Items',[{}])[0].get('FunctionARN')==arn)
     if arn and count>=100:
      return type('Result',(),{'returncode':1,'stdout':'','stderr':'TooManyDistributionsWithSingleFunctionARN'})()
     configs[ident]=c;updates.append(ident)
    else:raise AssertionError(op)
    return type('Result',(),{'returncode':0,'stdout':json.dumps(out),'stderr':''})()
   def run(action):
    with patch.object(sys,'argv',['script',action,'--profile','fixture','--state',tmp]),patch.object(m.subprocess,'run',side_effect=call),patch.object(m.time,'sleep'),patch('builtins.print'):
     m.main()
   run('apply')
   self.assertEqual(updates,ids[100:])
   self.assertEqual(len(functions),2)
   run('apply')
   self.assertEqual(updates,ids[100:])
   self.assertEqual(backups,{p.name:p.read_bytes() for p in folder.glob('*.original.json')})
   run('rollback')
   self.assertTrue(all(c==original for c in configs.values()))
if __name__=='__main__':unittest.main()
