/** Conservative lexical proof that eval text has no context-sensitive operations.
 * This never evaluates, rewrites, trims, returns a substitute value, or drops
 * input. A true result permits passing ORIGINAL bytes to the existing native
 * eval. All unrecognized text follows the normal rewrite path.
 *
 * Accepted subset: decimal integers (no leading zero except0), RegExp literals
 * (ordinary character classes/escapes; flags d,g,i,m,s,u,y), true/false/null,
 * separated only by commas, with ASCII whitespace and an optional final `;`.
 * Strings, templates, comments outside regexps, exponent/fraction/BigInt/hex
 * numbers, identifiers, operators, calls, members and multiple statements fail.
 * A lexically recognized but invalid RegExp still reaches native eval, which
 * throws its original SyntaxError; this helper never constructs the pattern.
 */
export function isPureLiteralEval(source: unknown): source is string {
  if (typeof source !== 'string') return false;
  const n=source.length;
  let i=0;
  const ws=()=>{while(i<n){const c=source[i];if(c===' '||c==='\t'||c==='\n'||c==='\r'||c==='\v'||c==='\f')i++;else break;}};
  const digit=(c:string|undefined)=>c!==undefined&&c>='0'&&c<='9';
  ws();
  if(i===n)return false;
  for(;;){
    const c=source[i];
    if(digit(c)){
      if(c==='0')i++;
      else {i++;while(i<n&&digit(source[i]))i++;}
    }else if(c==='/'){
      i++;
      // These begin comments, NOT a regexp literal.
      if(i===n||source[i]==='/'||source[i]==='*')return false;
      let inClass=false,closed=false;
      while(i<n){
        const r=source[i++];
        if(r==='\n'||r==='\r'||r==='\u2028'||r==='\u2029')return false;
        if(r==='\\'){
          if(i===n)return false;
          const escaped=source[i++];
          if(escaped==='\n'||escaped==='\r'||escaped==='\u2028'||escaped==='\u2029')return false;
        }else if(r==='['&&!inClass)inClass=true;
        else if(r===']'&&inClass)inClass=false;
        else if(r==='/'&&!inClass){closed=true;break;}
      }
      if(!closed)return false;
      let flags=0;
      while(i<n){
        const f=source[i];let bit=0;
        if(f==='d')bit=1;else if(f==='g')bit=2;else if(f==='i')bit=4;
        else if(f==='m')bit=8;else if(f==='s')bit=16;else if(f==='u')bit=32;
        else if(f==='y')bit=64;else break;
        if(flags&bit)return false;
        flags|=bit;i++;
      }
    }else if(c==='t'&&i+4<=n&&source[i+1]==='r'&&source[i+2]==='u'&&source[i+3]==='e')i+=4;
    else if(c==='f'&&i+5<=n&&source[i+1]==='a'&&source[i+2]==='l'&&source[i+3]==='s'&&source[i+4]==='e')i+=5;
    else if(c==='n'&&i+4<=n&&source[i+1]==='u'&&source[i+2]==='l'&&source[i+3]==='l')i+=4;
    else return false;
    ws();
    if(i===n)return true;
    if(source[i]===';'){i++;ws();return i===n;}
    if(source[i]!==',')return false;
    i++;ws();
    if(i===n)return false;
  }
}
