// Polyfill for fast-xml-parser to fix AWS SDK v3 compatibility
// This provides a browser-compatible XML parser implementation

class XMLParser {
  constructor(options = {}) {
    this.options = {
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      preserveOrder: false,
      ...options
    };
    this.externalEntities = {};
  }

  parse(xmlString) {
    try {
      // Basic XML parsing - for production use, consider using DOMParser
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
      
      if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
        throw new Error('XML parsing error');
      }
      
      return this.parseNode(xmlDoc.documentElement);
    } catch (error) {
      console.warn('XML parsing failed, returning raw string:', error);
      return xmlString;
    }
  }

  parseNode(node) {
    const result = {};
    
    // Parse attributes
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i];
        result[this.options.attributeNamePrefix + attr.name] = attr.value;
      }
    }
    
    // Parse child nodes
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.trim();
        if (text) {
          result['#text'] = text;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const childName = child.nodeName;
        const childData = this.parseNode(child);
        
        if (result[childName]) {
          if (Array.isArray(result[childName])) {
            result[childName].push(childData);
          } else {
            result[childName] = [result[childName], childData];
          }
        } else {
          result[childName] = childData;
        }
      }
    }
    
    return result;
  }

  // Add entity method that AWS SDK v3 expects
  addEntity(key, value) {
    if (value.indexOf("&") !== -1) {
      throw new Error("Entity value can't have '&'");
    } else if (key.indexOf("&") !== -1 || key.indexOf(";") !== -1) {
      throw new Error("An entity must be set without '&' and ';'. Eg. use '#xD' for '&#xD;'");
    } else if (value === "&") {
      throw new Error("An entity with value '&' is not permitted");
    } else {
      this.externalEntities[key] = value;
    }
  }

  // Add external entities method
  addExternalEntities(entities) {
    if (entities && typeof entities === 'object') {
      Object.assign(this.externalEntities, entities);
    }
  }
}

// Export as both default and named export for compatibility
export default XMLParser;
export { XMLParser };
