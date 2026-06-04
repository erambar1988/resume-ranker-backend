const { google } = require('googleapis');
const path = require('path');

// Initialize Google Drive API client
function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return google.drive({ version: 'v3', auth });
}

// List all resume files (PDF/DOCX/DOC) in a folder
async function listResumesInFolder(folderId) {
  const drive = getDriveClient();
  
  try {
    // Query for PDF and Word files in the folder
    const query = `'${folderId}' in parents and (mimeType='application/pdf' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/msword') and trashed=false`;
    
    const res = await drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType, size, modifiedTime)',
      pageSize: 100,
    });

    return res.data.files || [];
  } catch (err) {
    console.error('Error listing files from Drive:', err.message);
    throw new Error(`Failed to list files: ${err.message}`);
  }
}

// Download file from Google Drive and return as buffer
async function downloadFile(fileId) {
  const drive = getDriveClient();
  
  try {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    
    return Buffer.from(res.data);
  } catch (err) {
    console.error(`Error downloading file ${fileId}:`, err.message);
    throw new Error(`Failed to download file: ${err.message}`);
  }
}

// Search folders by name (to help users find their resume folder)
async function searchFolders(query) {
  const drive = getDriveClient();
  
  try {
    const searchQuery = `mimeType='application/vnd.google-apps.folder' and name contains '${query}' and trashed=false`;
    
    const res = await drive.files.list({
      q: searchQuery,
      fields: 'files(id, name, modifiedTime)',
      pageSize: 20,
    });

    return res.data.files || [];
  } catch (err) {
    console.error('Error searching folders:', err.message);
    throw new Error(`Failed to search folders: ${err.message}`);
  }
}

// Get folder info by ID
async function getFolderInfo(folderId) {
  const drive = getDriveClient();
  
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, modifiedTime',
    });

    return res.data;
  } catch (err) {
    console.error('Error getting folder info:', err.message);
    throw new Error(`Failed to get folder info: ${err.message}`);
  }
}

// Process all resumes from a Drive folder
async function processDriveFolder(folderId, onProgress) {
  const files = await listResumesInFolder(folderId);
  const results = [];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      if (onProgress) {
        onProgress(i + 1, files.length, file.name);
      }
      
      const buffer = await downloadFile(file.id);
      results.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        buffer: buffer,
        modifiedTime: file.modifiedTime,
      });
    } catch (err) {
      console.error(`Failed to process ${file.name}:`, err.message);
      results.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        error: err.message,
        modifiedTime: file.modifiedTime,
      });
    }
  }
  
  return results;
}

module.exports = {
  listResumesInFolder,
  downloadFile,
  searchFolders,
  getFolderInfo,
  processDriveFolder,
};
