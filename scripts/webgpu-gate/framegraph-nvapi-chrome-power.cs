using System;
using System.IO;
using System.Runtime.InteropServices;
// Offsets and function IDs verified against the saved NVIDIA/nvapi public headers.
public sealed class G09NvPower : IDisposable {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string file,IntPtr reserved,uint flags);
 [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
 [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr Query(uint id);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int NoArgs();
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Create(out IntPtr session);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Session(IntPtr session);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl,CharSet=CharSet.Unicode)] delegate int Find(IntPtr session,[MarshalAs(UnmanagedType.LPWStr)]string application,out IntPtr profile,IntPtr info);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Profile(IntPtr session,IntPtr profile,IntPtr info);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Get(IntPtr session,IntPtr profile,uint setting,IntPtr data);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Delete(IntPtr session,IntPtr profile,uint setting);
 IntPtr module,session,profile; Query query; public string ProfileName,ApplicationName; public uint ApplicationCount,SettingCount;
 const uint SettingId=0x1057eb71;
 const int SettingSize=12320;
 T Fn<T>(uint id) where T:class { var p=query(id);if(p==IntPtr.Zero)throw new Exception("NVAPI function unavailable: "+id.ToString("x"));return Marshal.GetDelegateForFunctionPointer(p,typeof(T)) as T; }
 static void Check(int status,string name){if(status!=0)throw new Exception(name+" failed: NVAPI "+status);}
 static IntPtr Buffer(int size,int version){var p=Marshal.AllocHGlobal(size);Marshal.Copy(new byte[size],0,p,size);Marshal.WriteInt32(p,size|(version<<16));return p;}
 public G09NvPower(){
  if(IntPtr.Size!=8)throw new Exception("64-bit PowerShell required");
  module=LoadLibraryEx(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"nvapi64.dll"),IntPtr.Zero,0x800);
  if(module==IntPtr.Zero)throw new Exception("System NVAPI DLL unavailable: "+Marshal.GetLastWin32Error());
  try {var ptr=GetProcAddress(module,"nvapi_QueryInterface");if(ptr==IntPtr.Zero)throw new Exception("NVAPI query export unavailable");query=(Query)Marshal.GetDelegateForFunctionPointer(ptr,typeof(Query));
   Check(Fn<NoArgs>(0x0150e828)(),"Initialize");Check(Fn<Create>(0x0694d52e)(out session),"CreateSession");Check(Fn<Session>(0x375dbd6b)(session),"LoadSettings");
   var app=Buffer(12296,1);try {Check(Fn<Find>(0xeee566b2)(session,"chrome.exe",out profile,app),"Find Chrome application");ApplicationName=Marshal.PtrToStringUni(IntPtr.Add(app,8));}finally{Marshal.FreeHGlobal(app);}
   var info=Buffer(4116,1);try {Check(Fn<Profile>(0x61cd6fd6)(session,profile,info),"GetProfileInfo");ProfileName=Marshal.PtrToStringUni(IntPtr.Add(info,4));ApplicationCount=(uint)Marshal.ReadInt32(info,4108);SettingCount=(uint)Marshal.ReadInt32(info,4112);}finally{Marshal.FreeHGlobal(info);}
  }catch{Dispose();throw;}
 }
 public sealed class Snapshot {public bool Found; public string ProfileName,ApplicationName; public uint ApplicationCount,SettingId,Type,Location,CurrentPredefined,PredefinedValid,PredefinedValue,Value;}
 public Snapshot Read(){var p=Buffer(SettingSize,1);try {int status=Fn<Get>(0x73bf8338)(session,profile,SettingId,p); if(status==-160)return new Snapshot{Found=false,ProfileName=ProfileName,ApplicationName=ApplicationName,ApplicationCount=ApplicationCount,SettingId=SettingId}; Check(status,"GetPowerSetting");
  var s=new Snapshot{Found=true,ProfileName=ProfileName,ApplicationName=ApplicationName,ApplicationCount=ApplicationCount,SettingId=(uint)Marshal.ReadInt32(p,4100),Type=(uint)Marshal.ReadInt32(p,4104),Location=(uint)Marshal.ReadInt32(p,4108),CurrentPredefined=(uint)Marshal.ReadInt32(p,4112),PredefinedValid=(uint)Marshal.ReadInt32(p,4116),PredefinedValue=(uint)Marshal.ReadInt32(p,4120),Value=(uint)Marshal.ReadInt32(p,8220)};
  if(s.SettingId!=SettingId||s.Type!=0||s.Location>3||s.Value>5||!string.Equals(s.ApplicationName,"chrome.exe",StringComparison.OrdinalIgnoreCase))throw new Exception("Unexpected power setting layout/value/profile");return s;
 }finally{Marshal.FreeHGlobal(p);}}
 public void SetPreferMaximum(){SetValue(1);}
 public void SetValue(uint value){if(value>5)throw new Exception("Invalid preferred power value");var p=Buffer(SettingSize,1);try{Marshal.WriteInt32(p,4100,unchecked((int)SettingId));Marshal.WriteInt32(p,8220,(int)value);Check(Fn<Profile>(0x577dd202)(session,profile,p),"SetPowerSetting");Check(Fn<Session>(0xfcbc7e14)(session),"SaveSettings");}finally{Marshal.FreeHGlobal(p);}}
 public void DeleteOverride(){Check(Fn<Delete>(0xe4a26362)(session,profile,SettingId),"DeletePowerOverride");Check(Fn<Session>(0xfcbc7e14)(session),"SaveSettings");}
 public void Dispose(){if(session!=IntPtr.Zero){var s=session;session=IntPtr.Zero;Check(Fn<Session>(0xdad9cff8)(s),"DestroySession");}if(module!=IntPtr.Zero){try{if(query!=null)Check(Fn<NoArgs>(0xd22bdd7e)(),"Unload");}finally{FreeLibrary(module);module=IntPtr.Zero;}}}
}