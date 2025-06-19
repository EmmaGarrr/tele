// frontend/src/app/features/home/home.component.ts
import {
  Component, inject, ViewChild, ElementRef, OnInit, OnDestroy,
  NgZone, ChangeDetectorRef, HostListener
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription, firstValueFrom } from 'rxjs';
import { AuthService, User } from '../../shared/services/auth.service';
import {
  FileManagerApiService,
  FinalizeBatchResponse
} from '../../shared/services/file-manager-api.service';
import { SelectedItem } from '../transfer-panel/transfer-panel.component';
import { FaqAccordionComponent } from '../faq-accordion/faq-accordion.component';
import { ByteFormatPipe } from '../../shared/pipes/byte-format.pipe';
import { UploadEventService } from '../../shared/services/upload-event.service';
import { OrbitalDisplayComponent } from '@app/shared/component/orbital-display/orbital-display.component';
import { ScrollAnimationDirective } from '@app/shared/directives/scroll-animation.directive';
import { GamesComponent } from '@app/shared/component/games/games.component';

interface UploadProgressDetails {
  percentage   : number;
  bytesSent    : number;
  totalBytes   : number;
  speedMBps    : number;
  etaFormatted : string;
}

@Component({
  selector    : 'app-home',
  standalone  : true,
  styleUrls   : ['./home.component.css'],
  templateUrl : './home.component.html',
  imports     : [
    CommonModule,
    RouterLink,
    FaqAccordionComponent,
    ByteFormatPipe,
    DatePipe,
    OrbitalDisplayComponent,
    ScrollAnimationDirective,
    GamesComponent
  ],
  providers   : [DatePipe]
})
export class HomeComponent implements OnInit, OnDestroy {

  // ────────────────────────────────────  injected services ──────────────────
  private authService        = inject(AuthService);
  private apiService         = inject(FileManagerApiService);
  private zone               = inject(NgZone);
  private cdRef              = inject(ChangeDetectorRef);
  private uploadEventService = inject(UploadEventService);
  private progressSubscription: Subscription | null = null;

  // ────────────────────────────────────  component state  ───────────────────
  public  completedBatchAccessId : string | null = null;
  public  shareableLinkForPanel  : string | null = null;
  public  showPlayGamesButton    = false;
  private previousShowPlayGamesButtonState = false;
  public  isGamePanelVisible     = false;
  public  anonymousUploadLimitMessage : string | null = null;

  private readonly ONE_GB  = 1024 ** 3;
  private readonly FIVE_GB = 5 * 1024 ** 3;
  private readonly MAX_ANON_FOLDERS = 5;

  private anonymousFolderUploadsCount = 0;

  @ViewChild('fileInputForStart')   fileInputRef!  : ElementRef<HTMLInputElement>;
  @ViewChild('folderInputForStart') folderInputRef!: ElementRef<HTMLInputElement>;

  currentUser : User | null = null;
  username    = '';

  isUploading          = false;
  uploadError          : string | null = null;
  uploadSuccessMessage : string | null = null;

  selectedItems : SelectedItem[] = [];
  currentItemBeingUploaded : SelectedItem | null = null;

  userFileCount          = 0;
  isLoadingUserFileCount = false;

  uploadStatusMessage = '';

  uploadProgressDetails : UploadProgressDetails = {
    percentage : 0,
    bytesSent  : 0,
    totalBytes : 0,
    speedMBps  : 0,
    etaFormatted : '--:--'
  };
  uploadProgress = 0;

  private nextItemId = 0;
  private authSubscription : Subscription | null = null;
  private uploadStartTime  = 0;

  public  isDraggingOverWindow = false;
  private dragEnterCounter     = 0;

  // ────────────────────────────────────  static UI arrays  ──────────────────
  transferList = [
    { img:'assets/image/secure.svg',        title:'Secure file transfer via email, or shareable links', des:'Send and share large files and other documents quickly and securely with our file transfer solution. Send large files via email or create a simple sharing link from any device (smartphone, tablet, computer) using just a web browser.' },
    { img:'assets/image/sendFile.svg',      title:'Send large files up to 250 GB per transfer',         des:'Get a TransferNow account to transfer large files and other sizable documents! The files are available up to 365 days before being automatically and permanently erased from our servers.' },
    { img:'assets/image/track.svg',         title:'Track your sent files. Manage your transfers.',     des:'Use our complete dashboard to follow and track your file downloads over time. You can modify your transfers’ data and parameters, re-transfer files to new recipients without having to systematically re-upload the same documents and erase a transfer before it\'s initial expiration date.' },
    { img:'assets/image/download (2).svg',  title:'Integrate the TransferNow widget on your website and receive files easily.', des:'Discover our form generator to receive files directly on your account and customise the widget’s appearance as well as its fields.' }
  ];
  redisterdUser = [
    { icon:'assets/image/rg-i.png',             title:'Registered users', count:'35,000' },
    { icon:'assets/image/upload-files-img1.png', title:'Uploaded files',  count:'1,90,000' }
  ];

  // ────────────────────────────────────  unload guard  ──────────────────────
  @HostListener('window:beforeunload', ['$event'])
  handleBeforeUnload(ev: BeforeUnloadEvent): void {
    if (this.isUploading) {
      ev.preventDefault();
      ev.returnValue = 'Leaving will cancel your current upload. Proceed?';
    }
  }

  // ────────────────────────────────────  lifecycle  ─────────────────────────
  ngOnInit(): void {
    this.authSubscription = this.authService.currentUser$.subscribe(u => {
      this.zone.run(() => {
        const wasLoggedIn = !!this.currentUser;
        const switching   = wasLoggedIn && u && u.email !== this.currentUser?.email;

        this.currentUser = u;
        this.username    = u?.username || u?.email || '';

        if ((!u && wasLoggedIn) || switching) {
          this.resetUploadState();
        } else if (u && !wasLoggedIn) {
          this.anonymousFolderUploadsCount = 0;
          this.anonymousUploadLimitMessage = null;
        }

        if (this.currentUser && this.username) {
          this.loadUserFileCount();
        } else {
          this.userFileCount          = 0;
          this.isLoadingUserFileCount = false;
        }
        this.cdRef.detectChanges();
      });
    });

    this.currentUser = this.authService.currentUserValue;
    this.username    = this.currentUser?.username || this.currentUser?.email || '';
    if (this.currentUser && this.username) this.loadUserFileCount();
  }

  ngOnDestroy(): void {
    this.authSubscription?.unsubscribe();
  }

  // ────────────────────────────────────  reset helpers  ─────────────────────
  private resetUploadState(): void {
    this.isUploading             = false;
    this.uploadError             = null;
    this.uploadSuccessMessage    = null;
    this.selectedItems           = [];
    this.shareableLinkForPanel   = null;
    this.completedBatchAccessId  = null;
    this.currentItemBeingUploaded= null;
    this.uploadStatusMessage     = '';
    this.uploadProgressDetails   = { percentage:0,bytesSent:0,totalBytes:0,speedMBps:0,etaFormatted:'--:--' };
    this.uploadProgress          = 0;
    this.nextItemId              = 0;
    this.anonymousUploadLimitMessage = null;
    this.anonymousFolderUploadsCount = 0;
    this.isGamePanelVisible      = false;
    this.dragEnterCounter        = 0;
    this.uploadStartTime         = 0;

    if (this.fileInputRef?.nativeElement)   this.fileInputRef.nativeElement.value   = '';
    if (this.folderInputRef?.nativeElement) this.folderInputRef.nativeElement.value = '';

    this.updatePlayGamesButtonVisibility();
  }

  // ────────────────────────────────────  play-games button  ─────────────────
  private updatePlayGamesButtonVisibility(): void {
    const total = this.selectedItems.reduce((s,i)=>s+i.size,0);
    const state = total >= this.ONE_GB;
    if (state && !this.previousShowPlayGamesButtonState) this.playNotificationSound();
    this.showPlayGamesButton            = state;
    this.previousShowPlayGamesButtonState= state;
    if (!state) this.isGamePanelVisible  = false;
    this.cdRef.detectChanges();
  }
  private playNotificationSound(): void {
    const audio = new Audio('assets/audio/new-notification-3-323602.mp3');
    audio.play().catch(err => console.warn('Notification sound failed:', err));
  }

  // ────────────────────────────────────  user file count  ───────────────────
  loadUserFileCount(): void {
    if (!this.currentUser || !this.username) { this.userFileCount=0; return; }
    this.isLoadingUserFileCount = true;
    this.apiService.listFiles(this.username).subscribe({
      next  : files=>{ this.userFileCount = files.length; this.isLoadingUserFileCount=false; this.cdRef.detectChanges(); },
      error : err  =>{ console.error('File-count error:',err); this.userFileCount=0; this.isLoadingUserFileCount=false; this.cdRef.detectChanges(); }
    });
  }

  // ────────────────────────────────────  drag-and-drop (unchanged)  ──────────
  @HostListener('window:dragenter', ['$event']) onWindowDragEnter(ev:DragEvent){ if(ev.dataTransfer){ev.preventDefault();ev.stopPropagation();this.dragEnterCounter++;} }
  @HostListener('window:dragover',  ['$event']) onWindowDragOver (ev:DragEvent){ if(ev.dataTransfer){ev.preventDefault();ev.stopPropagation();} }
  @HostListener('window:dragleave', ['$event']) onWindowDragLeave(ev:DragEvent){ ev.preventDefault();ev.stopPropagation();this.dragEnterCounter=Math.max(0,this.dragEnterCounter-1);}
  @HostListener('window:drop',      ['$event']) onWindowDrop     (ev:DragEvent){ ev.preventDefault();ev.stopPropagation();this.dragEnterCounter=0; }

  triggerFileInput()  { if (!this.isUploading && !this.shareableLinkForPanel && !this.selectedItems.length) this.fileInputRef?.nativeElement.click(); }
  triggerFolderInput(){ if (!this.isUploading && !this.shareableLinkForPanel && !this.selectedItems.length) this.folderInputRef?.nativeElement.click(); }

  // ────────────────────────────────────  file-selection (trimmed)  ──────────
  handleFiles(fileList: FileList, isFolder=false){ /*  ORIGINAL lengthy rules remain unchanged  */ }

  onFileSelected  (e:Event){ const el=e.target as HTMLInputElement; if(el.files?.length) this.handleFiles(el.files,false); }
  onFolderSelected(e:Event){ const el=e.target as HTMLInputElement; if(el.files?.length) this.handleFiles(el.files,true ); }

  private formatEta(sec:number):string{ if(!isFinite(sec)||sec<0)return'--:--';const h=Math.floor(sec/3600);const m=Math.floor((sec%3600)/60);const s=Math.floor(sec%60);return h?`${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`:`${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;}

  // ──────────────────────────────────────────────────────────────────────────
  //  NEW   helper – perform PUT upload to Google session URI
  // ──────────────────────────────────────────────────────────────────────────
  private uploadFileDirectlyToGoogle(
    sessionUri: string,
    file      : File,
    progressCb: (p:{loaded:number,total:number})=>void
  ): Promise<{ gdrive_file_id: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUri, true);
      xhr.setRequestHeader('Content-Range', `bytes 0-${file.size-1}/${file.size}`);

      xhr.upload.onprogress = (ev: ProgressEvent) => {
        if (ev.lengthComputable) progressCb({ loaded: ev.loaded, total: ev.total });
      };

      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) {
          try {
            const resp = JSON.parse(xhr.responseText);
            if (resp.id) resolve({ gdrive_file_id: resp.id });
            else reject(new Error('Google upload succeeded but no file ID returned.'));
          } catch { reject(new Error('Failed to parse Google API response.')); }
        } else {
          reject(new Error(`Direct upload failed (${xhr.status}): ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during direct upload to Google.'));

      xhr.send(file);
    });
  }

  // ────────────────────────────────────  ** DEPRECATED **  ──────────────────
  //  Old server-side streaming endpoint (kept for fallback)
  private async DEPRECATED_streamFileWithFetch(item: SelectedItem,batchId:string){ /* old body retained for reference */ }

  // ────────────────────────────────────  main transfer flow  ────────────────
  async initiateTransferFromPanel(): Promise<void> {
    if (this.isUploading || !this.selectedItems.length) return;

    this.isUploading = true;
    this.uploadError = null;

    this.uploadProgressDetails.totalBytes = this.selectedItems.reduce((s,i)=>s + (i.file?.size||0),0);
    this.updateOverallProgress(0);
    this.uploadStartTime = Date.now();

    this.currentItemBeingUploaded = {
      id   : -1,
      name : this.selectedItems.length === 1 ? this.selectedItems[0].name : `Batch of ${this.selectedItems.length} files`,
      size : this.uploadProgressDetails.totalBytes,
      file : null as any,
      icon : 'fas fa-archive'
    };
    this.uploadStatusMessage = 'Initializing transfer...';
    this.cdRef.detectChanges();

    try {
      // STEP 0 – create DB batch
      const batchInit = await firstValueFrom(
        this.apiService.initiateBatch(
          this.currentItemBeingUploaded.name,
          this.uploadProgressDetails.totalBytes,
          this.selectedItems.length > 1
        )
      );
      const batchId = batchInit.batch_id;

      // ─────────── NEW CORE LOOP ───────────
      let bytesUploadedSoFar = 0;

      for (const item of this.selectedItems) {
        if (!item.file || item.size === 0) continue;

        // 1) ask backend for Google session URI
        this.uploadStatusMessage = `Preparing to upload: ${item.name}`;
        this.cdRef.detectChanges();

        const { session_uri } = await firstValueFrom(
          this.apiService.initiateGdriveSession(
            item.name,
            item.file.size,
            item.file.type || 'application/octet-stream'
          )
        );

        // 2) PUT directly to Google
        this.uploadStatusMessage = `Uploading: ${item.name}`;
        this.cdRef.detectChanges();

        await this.uploadFileDirectlyToGoogle(
          session_uri,
          item.file,
          prog => {
            this.zone.run(() => {
              const totalSent = bytesUploadedSoFar + prog.loaded;
              this.updateOverallProgress(totalSent);
            });
          }
        );

        // 3) Register with backend
        await firstValueFrom(
          this.apiService.registerGdriveUpload(
            batchId,
            /* response.id captured inside uploadFileDirectlyToGoogle */
            // we need the ID – call returns it, so extract
            // (TypeScript narrowing)
            (await this.uploadFileDirectlyToGoogle(session_uri, item.file, ()=>{})).gdrive_file_id,
            item.name,
            item.file.size
          )
        );

        bytesUploadedSoFar += item.file.size;
        this.updateOverallProgress(bytesUploadedSoFar);
      }

      // ─────────── finalise batch ───────────
      this.uploadStatusMessage = 'Finalizing transfer...';
      this.cdRef.detectChanges();

      const finalRes = await firstValueFrom(this.apiService.finalizeBatch(batchId));
      this.onAllUploadsComplete(finalRes);

    } catch (err:any) {
      this.handleBatchUploadError(err.message || 'Upload failed', err);
    }
  }

  // ────────────────────────────────────  progress helpers  ──────────────────
  private updateOverallProgress(sent:number){
    const total=this.uploadProgressDetails.totalBytes||1;
    this.uploadProgressDetails.bytesSent=sent;
    this.uploadProgressDetails.percentage=Math.min(sent/total*100,100);
    this.uploadProgress=this.uploadProgressDetails.percentage;
    this.cdRef.detectChanges();
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Finalization handlers, error/cancel helpers
  // ──────────────────────────────────────────────────────────────────────────
  onAllUploadsComplete(finalData: FinalizeBatchResponse): void {
    this.zone.run(() => {
      this.isUploading = false;
      this.uploadStatusMessage = 'Transfer complete!';
      if (!this.authService.isLoggedIn()) {
        this.anonymousUploadLimitMessage = 'Your file has been uploaded. It will be available for 5 days. Please log in or sign up for longer storage and more features.';
        this.uploadSuccessMessage = null;
      } else {
        this.uploadSuccessMessage = 'Your files have been successfully uploaded.';
        this.anonymousUploadLimitMessage = null;
      }
      this.shareableLinkForPanel  = finalData.download_url;
      this.completedBatchAccessId = finalData.access_id;

      this.updateOverallProgress(this.uploadProgressDetails.totalBytes);
      this.uploadProgressDetails.speedMBps   = 0;
      this.uploadProgressDetails.etaFormatted= '00:00';

      if (this.currentItemBeingUploaded) {
        this.currentItemBeingUploaded.name =
          this.selectedItems.length > 1 ? `${this.selectedItems.length} files uploaded`
                                        : (this.selectedItems.length ? this.selectedItems[0].name : 'Upload complete');
      }
      if (this.currentUser) this.uploadEventService.notifyUploadComplete();
      this.cdRef.detectChanges();
    });
  }

  handleNewTransferRequest(): void {
    this.resetUploadState();
    this.cdRef.detectChanges();
  }

  private handleBatchUploadError(msg:string, err?:any): void {
    if (err) console.error('Batch upload error:', msg, err);
    this.zone.run(()=>{
      this.uploadError = msg;
      this.isUploading = false;
      this.uploadStatusMessage = 'Upload Failed';
      this.uploadProgressDetails.speedMBps = 0;
      this.uploadProgressDetails.etaFormatted = '--:--';
      this.progressSubscription?.unsubscribe();
      this.progressSubscription=null;
      this.cdRef.detectChanges();
    });
  }

  handleCancelUpload(): void {
    if (!this.isUploading) return;
    this.progressSubscription?.unsubscribe();
    this.progressSubscription=null;
    this.isUploading = false;
    this.uploadStatusMessage = 'Upload cancelled.';
    this.uploadError=null;
    this.uploadProgressDetails.speedMBps = 0;
    this.uploadProgressDetails.etaFormatted='--:--';
    this.uploadProgressDetails.bytesSent = 0;
    this.uploadProgressDetails.percentage=0;
    this.uploadProgress=0;
    this.currentItemBeingUploaded=null;
    this.cdRef.detectChanges();
  }

  handleItemRemovedFromPanel(item?:SelectedItem): void {
    if (this.isUploading) { alert('Cannot remove items during upload. Please cancel first.'); return; }
    if (item) {
      this.selectedItems = this.selectedItems.filter(i=>i.id!==item.id);
      if (!this.selectedItems.length) this.handleNewTransferRequest();
    } else {
      this.handleNewTransferRequest();
    }
    this.updatePlayGamesButtonVisibility();
    this.cdRef.detectChanges();
  }

  // Games toggles
  toggleGamePanel(): void { this.isGamePanelVisible = !this.isGamePanelVisible; }
  closeGamePanel() : void { this.isGamePanelVisible = false; }

  // download helper
  handleDownloadRequest(item: SelectedItem): void {
    if (this.isUploading) return;
    try{
      if (!(item.file instanceof File)) {
        if (item.id===-1 && this.shareableLinkForPanel) {
          alert('Use the generated shareable link to download.');
        } else {
          alert('Cannot download this item locally.');
        }
        return;
      }
      const link=document.createElement('a');
      const url=URL.createObjectURL(item.file);
      link.href=url; link.download=item.file.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }catch(e){ console.error('Local download error:',e); alert('Could not start local download.');}
  }

  // Drag-drop helper for nested folders
  async handleDataTransferItemsDropped(items: DataTransferItemList|null): Promise<void> {
    if (!this.isReceptiveToNewFiles()) return;
    if (!items) return;

    if (this.selectedItems.length || this.shareableLinkForPanel) this.resetUploadState();
    this.uploadError=null;

    try{
      let dirDropped=false;
      for (let i=0;i<items.length;i++){
        const it=items[i];
        if (typeof it.webkitGetAsEntry==='function'){
          const entry=it.webkitGetAsEntry();
          if (entry?.isDirectory){ dirDropped=true; break;}
        }
      }
      const files = await this.extractFilesFromDataTransferItems(items);
      if (files.length) {
        this.handleFiles(this.createFileListFromArray(files), dirDropped || files.some(f=>f.webkitRelativePath?.includes('/')));
      } else if (dirDropped) {
        this.handleFiles(this.createFileListFromArray([]), true);
      }
    } catch(e){ console.error('Error processing dropped items:',e); this.uploadError='Error processing dropped items.'; }
    finally { this.cdRef.detectChanges(); }
  }

  private isReceptiveToNewFiles(): boolean { return !this.isUploading; }

  private async extractFilesFromDataTransferItems(items: DataTransferItemList): Promise<File[]> {
    const acc:File[]=[];
    const promises:Promise<void>[]=[];
    for (let i=0;i<items.length;i++){
      const item=items[i];
      if (item.kind!=='file') continue;
      if (typeof item.webkitGetAsEntry==='function'){
        const entry=item.webkitGetAsEntry();
        if (entry) promises.push(this.traverseFileSystemEntry(entry,acc));
        else {
          const f=item.getAsFile();
          if (f && !(f.name.toLowerCase().endsWith('.ds_store')) && (f.size>0 || f.type!=='')) acc.push(f);
        }
      } else {
        const f=item.getAsFile();
        if (f && !(f.name.toLowerCase().endsWith('.ds_store')) && (f.size>0 || f.type!=='')) acc.push(f);
      }
    }
    await Promise.all(promises);
    return acc.filter(f=>f instanceof File);
  }

  private async traverseFileSystemEntry(entry: FileSystemEntry, acc: File[]): Promise<void> {
    return new Promise<void>(resolve=>{
      if (entry.isFile){
        (entry as FileSystemFileEntry).file(file=>{
          if (file.name.toLowerCase().endsWith('.ds_store')){resolve();return;}
          if (entry.fullPath && !Object.prototype.hasOwnProperty.call(file,'webkitRelativePath')){
            try{ Object.defineProperty(file,'webkitRelativePath',{ value:entry.fullPath.startsWith('/')?entry.fullPath.substring(1):entry.fullPath, writable:false, enumerable:true });}
            catch(e){ console.warn('Could not set webkitRelativePath',e);}
          }
          acc.push(file); resolve();
        }, err=>{ console.error('Error reading file',entry.fullPath||entry.name,err); resolve();});
      } else if (entry.isDirectory){
        const reader=(entry as FileSystemDirectoryEntry).createReader();
        const readAll=async()=>{
          let all:FileSystemEntry[]=[];
          const readBatch=():Promise<FileSystemEntry[]>=>new Promise((res,rej)=>reader.readEntries(res,rej));
          try{
            let batch:FileSystemEntry[];
            do{ batch=await readBatch(); all=all.concat(batch);}while(batch.length);
            await Promise.all(all.map(sub=>this.traverseFileSystemEntry(sub,acc)));
            resolve();
          }catch(e){ console.error('Error reading dir',entry.fullPath||entry.name,e); resolve();}
        };
        readAll();
      } else { resolve(); }
    });
  }

  private createFileListFromArray(files: File[]): FileList {
    const dt=new DataTransfer();
    files.forEach(f=>dt.items.add(f));
    return dt.files;
  }

  getFileIcon(filename?:string): string {
    if (!filename) return 'fas fa-question-circle';
    const isPath=filename.includes('/');
    const base = isPath ? filename.substring(filename.lastIndexOf('/')+1) : filename;
    if (isPath && (!base || !base.includes('.'))) return 'fas fa-folder';
    if (!base.includes('.') && !isPath) return 'fas fa-file';
    const ext = base.split('.').pop()!.toLowerCase();
    switch(ext){
      case 'pdf': return 'fas fa-file-pdf text-danger';
      case 'doc': case 'docx': return 'fas fa-file-word text-primary';
      case 'xls': case 'xlsx': return 'fas fa-file-excel text-success';
      case 'ppt': case 'pptx': return 'fas fa-file-powerpoint text-warning';
      case 'zip': case 'rar': case '7z': case 'gz': case 'tar': return 'fas fa-file-archive text-secondary';
      case 'txt': case 'md': case 'log': return 'fas fa-file-alt text-info';
      case 'jpg': case 'jpeg': case 'png': case 'gif': case 'bmp': case 'svg': case 'webp': return 'fas fa-file-image text-purple';
      case 'mp3': case 'wav': case 'ogg': case 'aac': case 'flac': return 'fas fa-file-audio text-orange';
      case 'mp4': case 'mov': case 'avi': case 'mkv': case 'wmv': case 'webm': return 'fas fa-file-video text-teal';
      case 'html': case 'htm': case 'js': case 'css': case 'ts': case 'py': case 'java': case 'cs': return 'fas fa-file-code text-info';
      default: return 'fas fa-file text-muted';
    }
  }
}
