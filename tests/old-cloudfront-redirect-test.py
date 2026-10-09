import copy, importlib.util, json, pathlib, subprocess, unittest
spec=importlib.util.spec_from_file_location('redirect',pathlib.Path(__file__).resolve().parents[1]/'scripts/redirect-old-cloudfront.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_account(self):
  m.check_account('237145860616')
  for account in ['083712835210','123456789012','']:
   with self.assertRaises(RuntimeError): m.check_account(account)
 def test_transform(self):
  b={'FunctionAssociations':{'Quantity':1,'Items':[{'EventType':'viewer-request','FunctionARN':'old'}]},'LambdaFunctionAssociations':{'Quantity':2,'Items':[{'EventType':'viewer-response','LambdaFunctionARN':'old'},{'EventType':'origin-request','LambdaFunctionARN':'keep'}]}}
  original={'Enabled':False,'Origins':{'Items':[{'DomainName':'original'}]},'DefaultCacheBehavior':b,'CacheBehaviors':{'Items':[copy.deepcopy(b)]}}
  before=copy.deepcopy(original)
  result=m.redirect_config(original,'new')
  self.assertEqual(before,original)
  self.assertTrue(result['Enabled'])
  self.assertEqual(result['Origins'],original['Origins'])
  for behavior in [result['DefaultCacheBehavior'],*result['CacheBehaviors']['Items']]:
   self.assertEqual(behavior['FunctionAssociations']['Items'],[{'EventType':'viewer-request','FunctionARN':'new'}])
   self.assertEqual(behavior['LambdaFunctionAssociations']['Quantity'],1)
  self.assertEqual(m.redirect_config(result,'new'),result)
 def test_javascript(self):
  out=subprocess.check_output(['node','-e',m.CODE+'console.log(JSON.stringify(handler({})))'],text=True)
  response=json.loads(out)
  self.assertEqual(response['statusCode'],302)
  self.assertEqual(response['headers']['location']['value'],m.TARGET)
  self.assertEqual(response['headers']['cache-control']['value'],'no-store')
if __name__=='__main__': unittest.main()
