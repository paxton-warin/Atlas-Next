import {test,expect} from "vitest";
import {collectEmails,deleteSnapshot} from "./bulkTools";
test("exports every page sorted, including all supplied accounts",async()=>{
 const result=await collectEmails(async page=>({users:[{id:String(page),email:page===1?"z@a.test":"a@a.test"}],pagination:{page,total:2,totalPages:2}}));
 expect(result).toBe("a@a.test\nz@a.test\n");
});
test("rejects changing totals",async()=>{
 await expect(collectEmails(async page=>({users:[{id:String(page),email:"a@a.test"}],pagination:{page,total:page,totalPages:2}}))).rejects.toThrow("changed");
});
test("deletes only reviewed IDs and stops on errors",async()=>{
 const ids=[1,2,3].map(n=>`00000000-0000-0000-0000-${String(n).padStart(12,"0")}`);
 const visited:string[]=[]; const progress:number[]=[];
 await expect(deleteSnapshot(ids,async id=>{visited.push(id);if(id===ids[1])throw Error("429");},n=>progress.push(n),async()=>{})).rejects.toThrow("429");
 expect(visited).toEqual(ids.slice(0,2));expect(progress).toEqual([1]);
});
test("duplicate IDs produce no deletes",async()=>{
 await expect(deleteSnapshot(["bad","bad"],async()=>{throw Error("unexpected")},()=>{},async()=>{})).rejects.toThrow("snapshot");
});
